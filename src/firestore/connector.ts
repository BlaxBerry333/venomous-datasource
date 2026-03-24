import type { Firestore, DocumentSnapshot, CollectionReference, Query } from '@google-cloud/firestore';
import type {
  DocumentConnector,
  FirestoreAuth,
  Document,
  DocumentInput,
  CollectionInfo,
  FieldInfo,
  DocFindOptions,
  DocPeekOptions,
  DocPeekResult,
  DocInsertResult,
  DocUpdateResult,
  DocDeleteResult,
  DocUpdateOptions,
  DocRemoveOptions,
  DocFilter,
  DocOrderByClause,
  PageResult,
} from '../core/index.js';
import {
  ConnectionError,
  AuthenticationError,
  PermissionError,
  QueryError,
  NotFoundError,
  validatePageSize,
  encodeCursor,
  decodeCursor,
} from '../core/index.js';
import { resolveAuth } from './auth.js';
import type { FirestoreOptions } from './types.js';

const CONNECTOR_NAME = 'firestore';
const DEFAULT_PEEK_ROWS = 10;
const DEFAULT_PAGE_SIZE = 50;
const BATCH_SIZE = 500;
const MAX_IN_ELEMENTS = 30;

/** Mapping from DocFilterOperator to Firestore WhereFilterOp. */
const OPERATOR_MAP: Record<string, FirebaseFirestore.WhereFilterOp> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  in: 'in',
};

/**
 * Firebase Firestore connector implementing the `DocumentConnector` interface.
 *
 * Maps Firestore's collection/document model to the unified document API.
 * Uses `firebase-admin` SDK for server-side access.
 *
 * @example
 * ```typescript
 * import { createFirestoreConnector } from 'venomous-datasource/firestore';
 *
 * const connector = createFirestoreConnector({ projectId: 'my-project' });
 * await connector.connect({ type: 'auto' });
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 * const doc = await connector.getById('users', 'user123');
 *
 * await connector.disconnect();
 * ```
 */
export class FirestoreConnector implements DocumentConnector<FirestoreAuth> {
  private readonly options: FirestoreOptions;
  private app: import('firebase-admin').app.App | null = null;
  private db: Firestore | null = null;
  private connected = false;
  private schemaCache = new Map<string, FieldInfo[]>();

  constructor(options?: FirestoreOptions) {
    this.options = options ?? {};
  }

  /**
   * Connect to Firestore and initialize the client.
   * Idempotent: if already connected, disconnects first then reconnects.
   *
   * @param auth - Authentication configuration. Defaults to `{ type: 'auto' }`.
   * @throws {ConnectionError} When firebase-admin is not installed or connection fails.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {PermissionError} When credentials lack sufficient permissions.
   */
  async connect(auth?: FirestoreAuth): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }

    const resolved = await resolveAuth(auth);

    // resolveAuth already imports firebase-admin (throwing ConnectionError if missing),
    // so we reuse the cached module import here.
    const admin = await import('firebase-admin');

    const projectId = this.options.projectId ?? resolved.projectId;
    const appName = `venomous-firestore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      this.app = admin.initializeApp(
        {
          credential: resolved.credential as import('firebase-admin').credential.Credential,
          projectId,
        },
        appName
      );

      const { getFirestore } = await import('firebase-admin/firestore');
      const databaseId = this.options.databaseId ?? '(default)';
      this.db = getFirestore(this.app, databaseId);
    } catch (err) {
      // Clean up partially initialized app
      if (this.app) {
        try {
          await this.app.delete();
        } catch {
          // Ignore cleanup errors
        }
        this.app = null;
      }
      throw wrapError(err, 'Failed to initialize Firestore connection');
    }

    // Verify connection by listing collections
    try {
      await this.db.listCollections();
    } catch (err) {
      // Clean up on verification failure
      if (this.app) {
        try {
          await this.app.delete();
        } catch {
          // Ignore cleanup errors
        }
        this.app = null;
        this.db = null;
      }
      throw wrapError(err, 'Failed to verify Firestore connection');
    }

    this.connected = true;
  }

  /**
   * Disconnect from Firestore and release all resources.
   * Idempotent: calling on an already-disconnected connector is a no-op.
   */
  async disconnect(): Promise<void> {
    this.schemaCache.clear();

    if (this.app) {
      try {
        await this.app.delete();
      } catch {
        // Ignore cleanup errors during disconnect
      }
      this.app = null;
    }

    this.db = null;
    this.connected = false;
  }

  /**
   * List all top-level collections.
   *
   * @returns Array of collection metadata (name only).
   */
  async collections(): Promise<CollectionInfo[]> {
    this.ensureConnected();

    try {
      const refs = await this.db!.listCollections();
      return refs.map((ref) => ({ name: ref.id }));
    } catch (err) {
      throw wrapError(err, 'Failed to list collections');
    }
  }

  /**
   * Preview the first N documents of a collection and infer field information.
   *
   * @param collection - Collection path (supports subcollections).
   * @param options - Preview options (default: 10 documents).
   * @returns Preview result with documents and optional inferred field info.
   */
  async peek(collection: string, options?: DocPeekOptions): Promise<DocPeekResult> {
    this.ensureConnected();

    const rows = options?.rows ?? DEFAULT_PEEK_ROWS;
    const limit = Math.max(1, Math.min(rows, 1000));

    try {
      const colRef = this.db!.collection(collection);
      const snapshot = await colRef.limit(limit).get();

      if (snapshot.empty) {
        return { data: [] };
      }

      // Infer fields from raw snapshots BEFORE type conversion,
      // so Firestore-specific types (Timestamp, GeoPoint, etc.) are correctly identified.
      const fields = this.schemaCache.get(collection) ?? inferFieldsFromSnapshots(snapshot.docs);

      const documents = snapshot.docs.map((doc) => documentToData(doc));

      // Cache inferred fields
      this.schemaCache.set(collection, fields);

      return {
        data: documents,
        fields,
      };
    } catch (err) {
      throw wrapError(err, `Failed to peek collection "${collection}"`);
    }
  }

  /**
   * Query documents with filtering, ordering, and pagination.
   *
   * @param collection - Collection path.
   * @param options - Query options (filter, orderBy, page).
   * @returns Paginated result set of documents.
   * @throws {QueryError} When the query is invalid.
   */
  async find(collection: string, options?: DocFindOptions): Promise<PageResult<Document>> {
    this.ensureConnected();

    const filter = options?.filter;
    const orderBy = options?.orderBy;
    const pageSize = options?.page?.size
      ? validatePageSize(options.page.size).value
      : DEFAULT_PAGE_SIZE;
    const cursor = options?.page?.cursor;

    try {
      const colRef = this.db!.collection(collection);
      let query: Query = buildQuery(colRef, filter, orderBy);

      // Handle cursor-based pagination
      if (cursor) {
        const cursorState = decodeCursor(cursor);
        const lastDocPath = cursorState['lastDocPath'] as string;

        if (!lastDocPath || typeof lastDocPath !== 'string') {
          throw new QueryError('Invalid cursor: missing lastDocPath', {
            code: 'VENOMOUS_INVALID_CURSOR',
            connector: CONNECTOR_NAME,
          });
        }

        const lastDocRef = this.db!.doc(lastDocPath);
        const lastDocSnapshot = await lastDocRef.get();

        if (!lastDocSnapshot.exists) {
          throw new QueryError(
            'Invalid cursor: the referenced document no longer exists. Please restart pagination.',
            { code: 'VENOMOUS_INVALID_CURSOR', connector: CONNECTOR_NAME }
          );
        }

        query = query.startAfter(lastDocSnapshot);
      }

      // Fetch one extra to determine hasMore
      const snapshot = await query.limit(pageSize + 1).get();
      const hasMore = snapshot.docs.length > pageSize;
      const docs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;

      const data = docs.map((doc) => documentToData(doc));

      let nextCursor: string | undefined;
      if (hasMore && docs.length > 0) {
        const lastDoc = docs[docs.length - 1]!;
        nextCursor = encodeCursor({ lastDocPath: lastDoc.ref.path });
      }

      return {
        data,
        nextCursor,
        hasMore,
      };
    } catch (err) {
      if (err instanceof QueryError) {
        throw err;
      }
      throw wrapError(err, `Failed to query collection "${collection}"`);
    }
  }

  /**
   * Get a single document by its ID.
   *
   * @param collection - Collection path.
   * @param id - Document ID (must not be empty or contain `/`).
   * @returns The document, or `null` if it does not exist.
   * @throws {QueryError} When the ID is invalid.
   */
  async getById(collection: string, id: string): Promise<Document | null> {
    this.ensureConnected();
    validateDocumentId(id);

    try {
      const docRef = this.db!.collection(collection).doc(id);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        return null;
      }

      return documentToData(snapshot);
    } catch (err) {
      if (err instanceof QueryError) {
        throw err;
      }
      throw wrapError(err, `Failed to get document "${id}" from "${collection}"`);
    }
  }

  /**
   * Insert documents into a collection.
   *
   * Uses WriteBatch internally (max 500 per batch). Multi-batch operations
   * are NOT atomic -- if a later batch fails, earlier batches are not rolled back.
   *
   * @param collection - Collection path.
   * @param docs - Array of documents to insert.
   * @returns Insert result with count and actual IDs used.
   * @throws {QueryError} When a document ID is invalid.
   */
  async insert(collection: string, docs: DocumentInput[]): Promise<DocInsertResult> {
    this.ensureConnected();

    if (docs.length === 0) {
      return { insertedCount: 0, insertedIds: [] };
    }

    // Validate all IDs upfront before writing
    for (const doc of docs) {
      if (doc.id !== undefined) {
        validateDocumentId(doc.id);
      }
    }

    const colRef = this.db!.collection(collection);
    const insertedIds: string[] = [];

    try {
      // Process in batches of BATCH_SIZE
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batchDocs = docs.slice(i, i + BATCH_SIZE);
        const batch = this.db!.batch();

        for (const doc of batchDocs) {
          let docRef;
          if (doc.id) {
            docRef = colRef.doc(doc.id);
          } else {
            docRef = colRef.doc();
          }
          batch.set(docRef, doc.data);
          insertedIds.push(docRef.id);
        }

        await batch.commit();
      }

      return {
        insertedCount: insertedIds.length,
        insertedIds,
      };
    } catch (err) {
      throw wrapError(err, `Failed to insert documents into "${collection}"`);
    }
  }

  /**
   * Update documents matching a filter.
   *
   * Uses WriteBatch internally. The filter must be non-empty to prevent
   * accidental mass updates.
   *
   * **Performance warning**: All matching documents are loaded into memory before
   * batch updates are applied. For large result sets (tens of thousands of documents
   * or more), consider applying more selective filters or batching at the application
   * layer to avoid excessive memory usage and Firestore read quota consumption.
   *
   * @param collection - Collection path.
   * @param options - Update options with filter and set values.
   * @returns Update result with count.
   * @throws {QueryError} When the filter is empty.
   */
  async update(collection: string, options: DocUpdateOptions): Promise<DocUpdateResult> {
    this.ensureConnected();
    validateNonEmptyFilter(options.filter);

    try {
      const colRef = this.db!.collection(collection);
      const query = buildQuery(colRef, options.filter);

      // Fetch all matching documents
      const snapshot = await query.get();

      if (snapshot.empty) {
        return { updatedCount: 0 };
      }

      // Update in batches
      const matchedDocs = snapshot.docs;
      for (let i = 0; i < matchedDocs.length; i += BATCH_SIZE) {
        const batchDocs = matchedDocs.slice(i, i + BATCH_SIZE);
        const batch = this.db!.batch();

        for (const doc of batchDocs) {
          batch.update(doc.ref, options.set);
        }

        await batch.commit();
      }

      return { updatedCount: matchedDocs.length };
    } catch (err) {
      if (err instanceof QueryError) {
        throw err;
      }
      throw wrapError(err, `Failed to update documents in "${collection}"`);
    }
  }

  /**
   * Delete documents matching a filter.
   *
   * Uses WriteBatch internally. The filter must be non-empty to prevent
   * accidental mass deletes.
   *
   * **Performance warning**: All matching documents are loaded into memory before
   * batch deletes are applied. For large result sets (tens of thousands of documents
   * or more), consider applying more selective filters or batching at the application
   * layer to avoid excessive memory usage and Firestore read quota consumption.
   *
   * @param collection - Collection path.
   * @param options - Remove options with filter.
   * @returns Delete result with count.
   * @throws {QueryError} When the filter is empty.
   */
  async remove(collection: string, options: DocRemoveOptions): Promise<DocDeleteResult> {
    this.ensureConnected();
    validateNonEmptyFilter(options.filter);

    try {
      const colRef = this.db!.collection(collection);
      const query = buildQuery(colRef, options.filter);

      // Fetch all matching documents
      const snapshot = await query.get();

      if (snapshot.empty) {
        return { deletedCount: 0 };
      }

      // Delete in batches
      const matchedDocs = snapshot.docs;
      for (let i = 0; i < matchedDocs.length; i += BATCH_SIZE) {
        const batchDocs = matchedDocs.slice(i, i + BATCH_SIZE);
        const batch = this.db!.batch();

        for (const doc of batchDocs) {
          batch.delete(doc.ref);
        }

        await batch.commit();
      }

      return { deletedCount: matchedDocs.length };
    } catch (err) {
      if (err instanceof QueryError) {
        throw err;
      }
      throw wrapError(err, `Failed to delete documents from "${collection}"`);
    }
  }

  /**
   * Ensure the connector is connected. Throws if not.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.db) {
      throw new ConnectionError(
        'Not connected to Firestore. Call connect() first.',
        { code: 'VENOMOUS_NOT_CONNECTED', connector: CONNECTOR_NAME }
      );
    }
  }
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Validate that a document ID is valid (non-empty, no `/`).
 *
 * @param id - Document ID to validate.
 * @throws {QueryError} When the ID is invalid.
 */
function validateDocumentId(id: string): void {
  if (!id || id.length === 0) {
    throw new QueryError(
      'Document ID must not be empty.',
      { code: 'VENOMOUS_INVALID_IDENTIFIER', connector: CONNECTOR_NAME }
    );
  }

  if (id.includes('/')) {
    throw new QueryError(
      `Document ID must not contain "/". Got: "${id}"`,
      { code: 'VENOMOUS_INVALID_IDENTIFIER', connector: CONNECTOR_NAME }
    );
  }
}

/**
 * Validate that a filter is non-empty.
 *
 * @param filter - Filter to validate.
 * @throws {QueryError} When the filter is empty.
 */
function validateNonEmptyFilter(filter: DocFilter): void {
  if (!filter || filter.length === 0) {
    throw new QueryError(
      'Filter must not be empty for update/remove operations. ' +
        'This prevents accidental modification of all documents.',
      { code: 'VENOMOUS_EMPTY_FILTER', connector: CONNECTOR_NAME }
    );
  }
}

/**
 * Build a Firestore Query from filter conditions and orderBy clauses.
 *
 * @param colRef - Collection reference.
 * @param filter - Optional filter conditions.
 * @param orderBy - Optional orderBy clauses.
 * @returns Constructed Firestore Query.
 */
function buildQuery(
  colRef: CollectionReference,
  filter?: DocFilter,
  orderBy?: DocOrderByClause[]
): Query {
  let query: Query = colRef;

  if (filter) {
    for (const condition of filter) {
      const op = OPERATOR_MAP[condition.operator];
      if (!op) {
        throw new QueryError(
          `Unsupported filter operator: "${condition.operator}"`,
          { code: 'VENOMOUS_INVALID_QUERY', connector: CONNECTOR_NAME }
        );
      }

      // Validate `in` operator element count
      if (condition.operator === 'in') {
        if (!Array.isArray(condition.value)) {
          throw new QueryError(
            `"in" operator requires an array value.`,
            { code: 'VENOMOUS_INVALID_QUERY', connector: CONNECTOR_NAME }
          );
        }
        if (condition.value.length > MAX_IN_ELEMENTS) {
          throw new QueryError(
            `"in" operator supports a maximum of ${MAX_IN_ELEMENTS} elements. Got: ${condition.value.length}`,
            { code: 'VENOMOUS_INVALID_QUERY', connector: CONNECTOR_NAME }
          );
        }
      }

      query = query.where(condition.field, op, condition.value);
    }
  }

  if (orderBy) {
    for (const clause of orderBy) {
      query = query.orderBy(clause.field, clause.direction);
    }
  }

  return query;
}

/**
 * Convert a Firestore DocumentSnapshot to a `Document` with recursive
 * type conversion for Firestore-specific types.
 *
 * @param snapshot - Firestore DocumentSnapshot.
 * @returns Converted Document with id and data.
 */
function documentToData(snapshot: DocumentSnapshot): Document {
  const rawData = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    data: convertValue(rawData) as Record<string, unknown>,
  };
}

/**
 * Recursively convert Firestore-specific types to JSON-serializable values.
 *
 * Handles: Timestamp, GeoPoint, DocumentReference, Bytes/Buffer,
 * nested objects (Maps), and arrays.
 */
function convertValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Timestamp -> ISO 8601 string
  if (isTimestamp(value)) {
    return value.toDate().toISOString();
  }

  // GeoPoint -> { latitude, longitude }
  if (isGeoPoint(value)) {
    return { latitude: value.latitude, longitude: value.longitude };
  }

  // DocumentReference -> path string
  if (isDocumentReference(value)) {
    return value.path;
  }

  // Bytes/Buffer -> base64 string
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }

  // Array -> recursively convert elements
  if (Array.isArray(value)) {
    return value.map(convertValue);
  }

  // Plain object (Map) -> recursively convert values
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertValue(v);
    }
    return result;
  }

  // Primitives (string, number, boolean) -> return as-is
  return value;
}

/**
 * Type guard for Firestore Timestamp.
 */
function isTimestamp(value: unknown): value is { toDate(): Date } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function' &&
    '_seconds' in value
  );
}

/**
 * Type guard for Firestore GeoPoint.
 */
function isGeoPoint(value: unknown): value is { latitude: number; longitude: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'latitude' in value &&
    'longitude' in value &&
    typeof (value as { latitude: unknown }).latitude === 'number' &&
    typeof (value as { longitude: unknown }).longitude === 'number' &&
    value.constructor?.name === 'GeoPoint'
  );
}

/**
 * Type guard for Firestore DocumentReference.
 */
function isDocumentReference(value: unknown): value is { path: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    'firestore' in value &&
    value.constructor?.name === 'DocumentReference'
  );
}

/**
 * Infer field information from raw Firestore DocumentSnapshots.
 *
 * Must be called BEFORE `documentToData()` conversion so that
 * Firestore-specific types (Timestamp, GeoPoint, DocumentReference, Bytes)
 * are correctly identified via their native class instances.
 *
 * @param snapshots - Array of raw Firestore DocumentSnapshots.
 * @returns Inferred field information.
 */
function inferFieldsFromSnapshots(snapshots: DocumentSnapshot[]): FieldInfo[] {
  const fieldTypes = new Map<string, string>();

  for (const snapshot of snapshots) {
    const rawData = snapshot.data() ?? {};
    for (const [key, value] of Object.entries(rawData)) {
      if (!fieldTypes.has(key) && value !== null && value !== undefined) {
        fieldTypes.set(key, inferType(value));
      }
    }
  }

  return Array.from(fieldTypes.entries()).map(([name, type]) => ({
    name,
    type,
    nullable: true, // Schema-less: any field can be absent in any document
  }));
}

/**
 * Infer the FieldInfo type string for a raw Firestore value.
 *
 * Checks Firestore-specific types first (Timestamp, GeoPoint, etc.)
 * before falling back to primitive type checks.
 */
function inferType(value: unknown): string {
  if (isTimestamp(value)) return 'TIMESTAMP';
  if (isGeoPoint(value)) return 'GEOPOINT';
  if (isDocumentReference(value)) return 'REFERENCE';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'BYTES';
  if (typeof value === 'string') return 'STRING';
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (Array.isArray(value)) return 'ARRAY';
  if (typeof value === 'object' && value !== null) return 'MAP';
  return 'STRING'; // Fallback
}

/**
 * Map Firebase/Firestore errors to appropriate VenomousError subclasses.
 *
 * @param err - The original error.
 * @param defaultMessage - Fallback message if the error has none.
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof ConnectionError ||
      err instanceof AuthenticationError ||
      err instanceof PermissionError ||
      err instanceof QueryError ||
      err instanceof NotFoundError) {
    throw err;
  }

  if (err instanceof Error) {
    const message = err.message || defaultMessage;
    const code = (err as { code?: string }).code;

    // Classify by Firebase Error Code
    if (code === 'unauthenticated') {
      throw new AuthenticationError(`Firestore authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'permission-denied') {
      throw new PermissionError(`Firestore permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'not-found') {
      throw new NotFoundError(`Firestore resource not found: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'unavailable' || code === 'deadline-exceeded') {
      throw new ConnectionError(`Firestore connection error: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'failed-precondition') {
      // Preserve index creation links in the message
      throw new QueryError(`Firestore query failed: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'invalid-argument') {
      throw new QueryError(`Firestore invalid argument: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'resource-exhausted') {
      throw new QueryError(`Firestore resource exhausted: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'already-exists') {
      throw new QueryError(`Firestore document already exists: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'cancelled') {
      throw new QueryError(`Firestore operation cancelled: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Message-based fallback classification
    const upperMessage = message.toUpperCase();

    if (upperMessage.includes('PERMISSION_DENIED')) {
      throw new PermissionError(`Firestore permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (
      upperMessage.includes('UNAUTHENTICATED') ||
      upperMessage.includes('CREDENTIAL') ||
      upperMessage.includes('AUTHENTICATION')
    ) {
      throw new AuthenticationError(`Firestore authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (
      upperMessage.includes('ECONNREFUSED') ||
      upperMessage.includes('ETIMEDOUT') ||
      upperMessage.includes('ENOTFOUND') ||
      upperMessage.includes('UNAVAILABLE')
    ) {
      throw new ConnectionError(`Firestore connection error: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`Firestore error: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  // Non-Error thrown
  throw new QueryError(`Firestore error: ${defaultMessage}`, {
    connector: CONNECTOR_NAME,
  });
}
