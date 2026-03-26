import type { MongoClient, Db, Filter, Sort, Document as MongoDocument } from 'mongodb';
import type {
  DocumentConnector,
  MongoDBAuth,
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
  DocFilterCondition,
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
import type { MongoDBOptions } from './types.js';

const CONNECTOR_NAME = 'mongodb';
const DEFAULT_PEEK_ROWS = 10;
const DEFAULT_PAGE_SIZE = 50;
const BATCH_SIZE = 1000;
const MAX_IN_ELEMENTS = 30;
const DEFAULT_TIMEOUT_MS = 10000;

/** Cursor type tags for correct deserialization of typed values. */
type CursorValueType = 'string' | 'number' | 'date' | 'objectid' | 'boolean' | 'null';

interface CursorTaggedValue {
  t: CursorValueType;
  v: string;
}

/**
 * MongoDB connector implementing the `DocumentConnector` interface.
 *
 * Maps MongoDB's collection/document model to the unified document API.
 * Uses the official `mongodb` Node.js driver (v6+).
 *
 * @example
 * ```typescript
 * import { createMongoDBConnector } from 'venomous-datasource/mongodb';
 *
 * const connector = createMongoDBConnector({ database: 'mydb' });
 * await connector.connect({ type: 'auto' });
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 * const doc = await connector.getById('users', '507f1f77bcf86cd799439011');
 *
 * await connector.disconnect();
 * ```
 */
export class MongoDBConnector implements DocumentConnector<MongoDBAuth> {
  private readonly options: MongoDBOptions;
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connected = false;
  private schemaCache = new Map<string, FieldInfo[]>();

  constructor(options: MongoDBOptions) {
    this.options = options;
  }

  /**
   * Connect to MongoDB and initialize the client.
   * Idempotent: if already connected, disconnects first then reconnects.
   *
   * @param auth - Authentication configuration. Defaults to `{ type: 'auto' }`.
   * @throws {ConnectionError} When mongodb SDK is not installed or connection fails.
   * @throws {AuthenticationError} When credentials are invalid.
   */
  async connect(auth?: MongoDBAuth): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }

    const resolved = await resolveAuth(auth);

    // resolveAuth already imports 'mongodb' to verify SDK availability.
    // This second import is virtually free due to Node.js module cache.
    const { MongoClient: MongoClientClass } = await import('mongodb');

    const connectTimeoutMS = this.options.connectTimeoutMS ?? DEFAULT_TIMEOUT_MS;
    const serverSelectionTimeoutMS = this.options.serverSelectionTimeoutMS ?? DEFAULT_TIMEOUT_MS;

    let client: MongoClient | null = null;
    try {
      client = new MongoClientClass(resolved.uri, {
        connectTimeoutMS,
        serverSelectionTimeoutMS,
      });
      await client.connect();

      // Verify connection with ping
      const db = client.db(this.options.database);
      await db.command({ ping: 1 });

      this.client = client;
      this.db = db;
      this.connected = true;
    } catch (err) {
      // Clean up on failure
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
      throw wrapError(err, 'Failed to connect to MongoDB');
    }
  }

  /**
   * Disconnect from MongoDB and release all resources.
   * Idempotent: calling on an already-disconnected connector is a no-op.
   */
  async disconnect(): Promise<void> {
    this.schemaCache.clear();

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore cleanup errors during disconnect
      }
      this.client = null;
    }

    this.db = null;
    this.connected = false;
  }

  /**
   * List all collections in the database.
   * Filters out `system.*` collections and views.
   *
   * @returns Array of collection metadata (name only).
   */
  async collections(): Promise<CollectionInfo[]> {
    this.ensureConnected();

    try {
      const items = await this.db!.listCollections().toArray();
      return items
        .filter((item) => item.type === 'collection' && !item.name.startsWith('system.'))
        .map((item) => ({ name: item.name }));
    } catch (err) {
      throw wrapError(err, 'Failed to list collections');
    }
  }

  /**
   * Preview the first N documents of a collection and infer field information.
   *
   * @param collection - Collection name.
   * @param options - Preview options (default: 10 documents).
   * @returns Preview result with documents and optional inferred field info.
   */
  async peek(collection: string, options?: DocPeekOptions): Promise<DocPeekResult> {
    this.ensureConnected();

    const rows = options?.rows ?? DEFAULT_PEEK_ROWS;
    const limit = Math.max(1, Math.min(rows, 1000));

    try {
      const col = this.db!.collection(collection);
      const docs = await col.find().limit(limit).toArray();

      if (docs.length === 0) {
        return { data: [] };
      }

      const fields = this.schemaCache.get(collection) ?? inferFieldsFromDocuments(docs);
      const documents = docs.map((doc) => documentToData(doc));

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
   * Uses cursor-based pagination. When no `orderBy` is specified, paginates
   * by `_id`. When custom `orderBy` is specified, uses a compound sort
   * with `_id` as tiebreaker and `$or` conditions for cursor positioning.
   *
   * @param collection - Collection name.
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
      const col = this.db!.collection(collection);

      // Build base filter from DocFilter
      let mongoFilter: Filter<MongoDocument> = buildMongoFilter(filter);

      // Build sort
      const mongoSort: Sort = buildMongoSort(orderBy);

      // Handle cursor-based pagination
      if (cursor) {
        const cursorState = decodeCursor(cursor);
        const cursorFilter = await buildCursorFilter(cursorState, orderBy);
        if (Object.keys(mongoFilter).length > 0) {
          mongoFilter = { $and: [mongoFilter, cursorFilter] } as Filter<MongoDocument>;
        } else {
          mongoFilter = cursorFilter;
        }
      }

      // Fetch one extra to determine hasMore
      const docs = await col
        .find(mongoFilter)
        .sort(mongoSort)
        .limit(pageSize + 1)
        .toArray();

      const hasMore = docs.length > pageSize;
      const resultDocs = hasMore ? docs.slice(0, pageSize) : docs;
      const data = resultDocs.map((doc) => documentToData(doc));

      let nextCursor: string | undefined;
      if (hasMore && resultDocs.length > 0) {
        const lastDoc = resultDocs[resultDocs.length - 1]!;
        nextCursor = buildNextCursor(lastDoc, orderBy);
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
   * Attempts to match both ObjectId and string forms of the ID
   * when the ID is a valid 24-character hexadecimal string.
   *
   * @param collection - Collection name.
   * @param id - Document ID (must not be empty or contain `/`).
   * @returns The document, or `null` if it does not exist.
   * @throws {QueryError} When the ID is invalid.
   */
  async getById(collection: string, id: string): Promise<Document | null> {
    this.ensureConnected();
    validateDocumentId(id);

    try {
      const col = this.db!.collection(collection);
      let doc: MongoDocument | null;

      if (isObjectIdHex(id)) {
        const { ObjectId } = await import('mongodb');
        // Query both ObjectId and string forms, ObjectId first (priority)
        doc = await col.findOne({
          $or: [{ _id: new ObjectId(id) }, { _id: id }],
        } as unknown as Filter<MongoDocument>);
      } else {
        doc = await col.findOne({
          _id: id,
        } as unknown as Filter<MongoDocument>);
      }

      if (!doc) {
        return null;
      }

      return documentToData(doc);
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
   * Uses `insertMany` with `ordered: false` (best-effort insertion).
   * Large batches are split into chunks of 1000. Multi-batch operations
   * are NOT atomic -- if a later batch fails, earlier batches are not rolled back.
   *
   * @param collection - Collection name.
   * @param docs - Array of documents to insert.
   * @returns Insert result with count and actual IDs used.
   * @throws {QueryError} When a document ID is invalid or a duplicate key is encountered.
   */
  async insert(collection: string, docs: DocumentInput[]): Promise<DocInsertResult> {
    this.ensureConnected();

    if (docs.length === 0) {
      return { insertedCount: 0, insertedIds: [] };
    }

    // Validate all IDs upfront
    for (const doc of docs) {
      if (doc.id !== undefined) {
        validateDocumentId(doc.id);
      }
    }

    const col = this.db!.collection(collection);
    const insertedIds: string[] = [];

    try {
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batchDocs = docs.slice(i, i + BATCH_SIZE);
        const { ObjectId } = await import('mongodb');
        const mongoDocs: MongoDocument[] = [];

        for (const doc of batchDocs) {
          const mongoDoc: MongoDocument = { ...doc.data };
          if (doc.id !== undefined) {
            // If it's a valid 24-char hex string, store as ObjectId; otherwise string
            mongoDoc['_id'] = isObjectIdHex(doc.id) ? new ObjectId(doc.id) : doc.id;
          }
          mongoDocs.push(mongoDoc);
        }

        const result = await col.insertMany(mongoDocs, { ordered: false });

        // Collect inserted IDs
        for (let j = 0; j < mongoDocs.length; j++) {
          const insertedId = result.insertedIds[j];
          insertedIds.push(String(insertedId));
        }
      }

      return {
        insertedCount: insertedIds.length,
        insertedIds,
      };
    } catch (err) {
      const context = `(${insertedIds.length} of ${docs.length} inserted before failure)`;
      const fallbackMessage = `Failed to insert documents into "${collection}" ${context}`;

      // Append partial success context to the original error message so it is
      // always visible, regardless of whether wrapError uses err.message or
      // the defaultMessage fallback.
      if (err instanceof Error && err.message) {
        err.message = `${err.message} ${context}`;
      }

      throw wrapError(err, fallbackMessage);
    }
  }

  /**
   * Update documents matching a filter.
   *
   * Uses MongoDB's native `updateMany` with `$set` semantics (partial update,
   * does not replace the entire document).
   *
   * @param collection - Collection name.
   * @param options - Update options with filter and set values.
   * @returns Update result with count.
   * @throws {QueryError} When the filter is empty.
   */
  async update(collection: string, options: DocUpdateOptions): Promise<DocUpdateResult> {
    this.ensureConnected();
    validateNonEmptyFilter(options.filter);

    try {
      const col = this.db!.collection(collection);
      const mongoFilter = buildMongoFilter(options.filter);
      const result = await col.updateMany(mongoFilter, { $set: options.set });

      return { updatedCount: result.modifiedCount };
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
   * Uses MongoDB's native `deleteMany`.
   *
   * @param collection - Collection name.
   * @param options - Remove options with filter.
   * @returns Delete result with count.
   * @throws {QueryError} When the filter is empty.
   */
  async remove(collection: string, options: DocRemoveOptions): Promise<DocDeleteResult> {
    this.ensureConnected();
    validateNonEmptyFilter(options.filter);

    try {
      const col = this.db!.collection(collection);
      const mongoFilter = buildMongoFilter(options.filter);
      const result = await col.deleteMany(mongoFilter);

      return { deletedCount: result.deletedCount };
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
      throw new ConnectionError('Not connected to MongoDB. Call connect() first.', {
        code: 'VENOMOUS_NOT_CONNECTED',
        connector: CONNECTOR_NAME,
      });
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
    throw new QueryError('Document ID must not be empty.', {
      code: 'VENOMOUS_INVALID_IDENTIFIER',
      connector: CONNECTOR_NAME,
    });
  }

  if (id.includes('/')) {
    throw new QueryError(`Document ID must not contain "/". Got: "${id}"`, {
      code: 'VENOMOUS_INVALID_IDENTIFIER',
      connector: CONNECTOR_NAME,
    });
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
 * Check if a string is a valid ObjectId hex (24 hex characters).
 */
function isObjectIdHex(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Convert a MongoDB document to a `Document` with `_id` mapped to `id`.
 *
 * @param doc - Raw MongoDB document.
 * @returns Converted Document with id and data.
 */
function documentToData(doc: MongoDocument): Document {
  const { _id, ...data } = doc;
  return {
    id: idToString(_id),
    data: data as Record<string, unknown>,
  };
}

/**
 * Convert any `_id` value to a string representation.
 */
function idToString(id: unknown): string {
  if (id === null || id === undefined) {
    return '';
  }
  // ObjectId has toHexString()
  if (typeof id === 'object' && id !== null && 'toHexString' in id) {
    return (id as { toHexString(): string }).toHexString();
  }
  return String(id);
}

/**
 * Infer field information from raw MongoDB documents.
 *
 * For each field, the type is determined by the first non-null/undefined value
 * encountered across all sampled documents. When the same field has different
 * types in different documents (common in schema-less databases), only the
 * first observed type is reported. This is a known limitation consistent with
 * the Firestore connector's `inferFieldsFromSnapshots` behavior.
 *
 * @param docs - Array of MongoDB documents.
 * @returns Inferred field information.
 */
function inferFieldsFromDocuments(docs: MongoDocument[]): FieldInfo[] {
  const fieldTypes = new Map<string, string>();

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      if (key === '_id') continue; // _id is not part of `data`
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
 * Infer the FieldInfo type string for a MongoDB value.
 */
function inferType(value: unknown): string {
  if (typeof value === 'string') return 'STRING';
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (value instanceof Date) return 'DATE';
  // ObjectId detection
  if (
    typeof value === 'object' &&
    value !== null &&
    'toHexString' in value &&
    value.constructor?.name === 'ObjectId'
  ) {
    return 'OBJECTID';
  }
  // Binary / Buffer / Uint8Array
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'BINARY';
  if (typeof value === 'object' && value !== null && value.constructor?.name === 'Binary') {
    return 'BINARY';
  }
  if (Array.isArray(value)) return 'ARRAY';
  if (typeof value === 'object' && value !== null) return 'OBJECT';
  return 'STRING'; // Fallback
}

/**
 * Build a MongoDB filter object from DocFilter conditions.
 * Multiple conditions on the same field use `$and`.
 *
 * @param filter - DocFilter conditions (AND combined).
 * @returns MongoDB filter object.
 */
function buildMongoFilter(filter?: DocFilter): Filter<MongoDocument> {
  if (!filter || filter.length === 0) {
    return {};
  }

  // Track fields that have multiple conditions (need $and)
  const fieldConditions = new Map<string, Record<string, unknown>[]>();

  for (const condition of filter) {
    validateFilterCondition(condition);
    const mongoCondition = toMongoCondition(condition);

    const existing = fieldConditions.get(condition.field);
    if (existing) {
      existing.push(mongoCondition);
    } else {
      fieldConditions.set(condition.field, [mongoCondition]);
    }
  }

  // Check if any field has multiple conditions
  let hasMultiConditionField = false;
  for (const [, conditions] of fieldConditions) {
    if (conditions.length > 1) {
      hasMultiConditionField = true;
      break;
    }
  }

  if (!hasMultiConditionField) {
    // Simple case: merge all into one object
    const result: Record<string, unknown> = {};
    for (const [, conditions] of fieldConditions) {
      const cond = conditions[0]!;
      Object.assign(result, cond);
    }
    return result as Filter<MongoDocument>;
  }

  // Complex case: use $and for all conditions
  const andConditions: Record<string, unknown>[] = [];
  for (const [, conditions] of fieldConditions) {
    for (const cond of conditions) {
      andConditions.push(cond);
    }
  }
  return { $and: andConditions } as Filter<MongoDocument>;
}

/**
 * Validate a single filter condition.
 */
function validateFilterCondition(condition: DocFilterCondition): void {
  const validOps = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in'];
  if (!validOps.includes(condition.operator)) {
    throw new QueryError(`Unsupported filter operator: "${condition.operator}"`, {
      code: 'VENOMOUS_INVALID_QUERY',
      connector: CONNECTOR_NAME,
    });
  }

  if (condition.operator === 'in') {
    if (!Array.isArray(condition.value)) {
      throw new QueryError('"in" operator requires an array value.', {
        code: 'VENOMOUS_INVALID_QUERY',
        connector: CONNECTOR_NAME,
      });
    }
    if ((condition.value as unknown[]).length > MAX_IN_ELEMENTS) {
      throw new QueryError(
        `"in" operator supports a maximum of ${MAX_IN_ELEMENTS} elements. ` +
          `Got: ${(condition.value as unknown[]).length}`,
        { code: 'VENOMOUS_INVALID_QUERY', connector: CONNECTOR_NAME }
      );
    }
  }
}

/**
 * Convert a single DocFilterCondition to a MongoDB filter fragment.
 */
function toMongoCondition(condition: DocFilterCondition): Record<string, unknown> {
  const { field, operator, value } = condition;

  switch (operator) {
    case 'eq':
      return { [field]: value };
    case 'ne':
      return { [field]: { $ne: value } };
    case 'gt':
      return { [field]: { $gt: value } };
    case 'lt':
      return { [field]: { $lt: value } };
    case 'gte':
      return { [field]: { $gte: value } };
    case 'lte':
      return { [field]: { $lte: value } };
    case 'in':
      return { [field]: { $in: value } };
    default: {
      const _exhaustive: never = operator;
      throw new QueryError(`Unsupported filter operator: "${String(_exhaustive)}"`, {
        code: 'VENOMOUS_INVALID_QUERY',
        connector: CONNECTOR_NAME,
      });
    }
  }
}

/**
 * Build a MongoDB sort object from DocOrderByClause array.
 * Always appends `_id` as the tiebreaker for stable pagination.
 */
function buildMongoSort(orderBy?: DocOrderByClause[]): Sort {
  const sort: Record<string, 1 | -1> = {};

  if (orderBy && orderBy.length > 0) {
    for (const clause of orderBy) {
      sort[clause.field] = clause.direction === 'asc' ? 1 : -1;
    }
  }

  // Always add _id as tiebreaker in ascending order (if not already present).
  // Intentional design decision: _id tiebreaker is always asc regardless of
  // user-specified sort directions. This matches Firestore's startAfter behavior
  // (which uses document ID's natural order) and ensures cross-connector consistency.
  // The cursor filter in buildCursorFilter uses $gt for _id to match this direction.
  if (!sort['_id']) {
    sort['_id'] = 1;
  }

  return sort;
}

/**
 * Tag a value for cursor serialization, preserving type information.
 */
function tagCursorValue(value: unknown): CursorTaggedValue {
  if (value === null || value === undefined) {
    return { t: 'null', v: '' };
  }
  if (value instanceof Date) {
    return { t: 'date', v: value.toISOString() };
  }
  if (typeof value === 'object' && value !== null && 'toHexString' in value) {
    return { t: 'objectid', v: (value as { toHexString(): string }).toHexString() };
  }
  if (typeof value === 'number') {
    return { t: 'number', v: String(value) };
  }
  if (typeof value === 'boolean') {
    return { t: 'boolean', v: String(value) };
  }
  return { t: 'string', v: String(value) };
}

/**
 * Restore a tagged cursor value to its original typed form.
 */
async function untagCursorValue(tagged: CursorTaggedValue): Promise<unknown> {
  switch (tagged.t) {
    case 'null':
      return null;
    case 'date':
      return new Date(tagged.v);
    case 'objectid': {
      const { ObjectId } = await import('mongodb');
      return new ObjectId(tagged.v);
    }
    case 'number':
      return Number(tagged.v);
    case 'boolean':
      return tagged.v === 'true';
    case 'string':
      return tagged.v;
    default:
      return tagged.v;
  }
}

/**
 * Build the next cursor from the last document in a result set.
 */
function buildNextCursor(lastDoc: MongoDocument, orderBy?: DocOrderByClause[]): string {
  const cursorData: Record<string, unknown> = {
    lastId: tagCursorValue(lastDoc['_id']),
  };

  if (orderBy && orderBy.length > 0) {
    const lastSortValues: CursorTaggedValue[] = orderBy.map((clause) =>
      tagCursorValue(lastDoc[clause.field])
    );
    cursorData['lastSortValues'] = lastSortValues;
  }

  return encodeCursor(cursorData);
}

/**
 * Build a cursor filter for pagination using `$or` conditions.
 *
 * For simple pagination (no orderBy): `{ _id: { $gt: lastId } }`
 *
 * For compound pagination (with orderBy), uses recursive `$or`:
 * ```
 * { $or: [
 *   { field1: { $gt: lastVal1 } },                           // strict on field1
 *   { field1: lastVal1, field2: { $gt: lastVal2 } },        // equal on field1, strict on field2
 *   { field1: lastVal1, field2: lastVal2, _id: { $gt: lastId } }  // equal on all, strict on _id
 * ] }
 * ```
 * `desc` fields use `$lt` instead of `$gt`.
 */
async function buildCursorFilter(
  cursorState: Record<string, unknown>,
  orderBy?: DocOrderByClause[]
): Promise<Filter<MongoDocument>> {
  const lastIdTagged = cursorState['lastId'] as CursorTaggedValue;
  if (!lastIdTagged || typeof lastIdTagged !== 'object') {
    throw new QueryError('Invalid cursor: missing lastId', {
      code: 'VENOMOUS_INVALID_CURSOR',
      connector: CONNECTOR_NAME,
    });
  }

  const lastId = await untagCursorValue(lastIdTagged);

  if (!orderBy || orderBy.length === 0) {
    // Simple _id-based pagination
    return { _id: { $gt: lastId } } as Filter<MongoDocument>;
  }

  // Compound pagination with orderBy
  const lastSortValues = cursorState['lastSortValues'] as CursorTaggedValue[];
  if (!lastSortValues || !Array.isArray(lastSortValues)) {
    throw new QueryError('Invalid cursor: missing lastSortValues', {
      code: 'VENOMOUS_INVALID_CURSOR',
      connector: CONNECTOR_NAME,
    });
  }

  if (lastSortValues.length !== orderBy.length) {
    throw new QueryError('Invalid cursor: lastSortValues length mismatch', {
      code: 'VENOMOUS_INVALID_CURSOR',
      connector: CONNECTOR_NAME,
    });
  }

  const restoredValues: unknown[] = [];
  for (const tagged of lastSortValues) {
    restoredValues.push(await untagCursorValue(tagged));
  }

  // Build recursive $or conditions
  const orConditions: Record<string, unknown>[] = [];

  for (let i = 0; i < orderBy.length; i++) {
    const condition: Record<string, unknown> = {};

    // All previous fields must be equal
    for (let j = 0; j < i; j++) {
      condition[orderBy[j]!.field] = restoredValues[j];
    }

    // Current field is strictly greater/less
    const direction = orderBy[i]!.direction;
    const op = direction === 'asc' ? '$gt' : '$lt';
    condition[orderBy[i]!.field] = { [op]: restoredValues[i] };

    orConditions.push(condition);
  }

  // Final condition: all sort fields equal, _id tiebreaker uses $gt (asc).
  // See buildMongoSort for rationale on always-asc _id tiebreaker.
  const tiebreaker: Record<string, unknown> = {};
  for (let j = 0; j < orderBy.length; j++) {
    tiebreaker[orderBy[j]!.field] = restoredValues[j];
  }
  tiebreaker['_id'] = { $gt: lastId };
  orConditions.push(tiebreaker);

  return { $or: orConditions } as Filter<MongoDocument>;
}

/**
 * Sanitize a URI in an error message by redacting the password portion.
 * Handles both `mongodb://user:pass@host` and `mongodb+srv://user:pass@host` formats.
 */
function redactUriInMessage(message: string): string {
  // Redact the entire credentials portion (user:pass) between :// and the last @.
  // This handles passwords containing special characters like '@' (which may not
  // be percent-encoded in user-provided connection strings).
  return message.replace(/mongodb(\+srv)?:\/\/[^@]*@/g, 'mongodb$1://[REDACTED]@');
}

/**
 * Map MongoDB errors to appropriate VenomousError subclasses.
 *
 * @param err - The original error.
 * @param defaultMessage - Fallback message if the error has none.
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (
    err instanceof ConnectionError ||
    err instanceof AuthenticationError ||
    err instanceof PermissionError ||
    err instanceof QueryError ||
    err instanceof NotFoundError
  ) {
    throw err;
  }

  if (err instanceof Error) {
    const rawMessage = err.message || defaultMessage;
    const message = redactUriInMessage(rawMessage);
    const code = (err as { code?: number | string }).code;
    const errName = err.constructor?.name ?? '';

    // Classify by MongoDB error code (numeric)
    if (typeof code === 'number') {
      if (code === 18) {
        throw new AuthenticationError(`MongoDB authentication failed: ${message}`, {
          cause: err,
          connector: CONNECTOR_NAME,
        });
      }
      if (code === 13) {
        throw new PermissionError(`MongoDB permission denied: ${message}`, {
          cause: err,
          connector: CONNECTOR_NAME,
        });
      }
      if (code === 11000) {
        throw new QueryError(`MongoDB duplicate key: ${message}`, {
          code: 'VENOMOUS_DUPLICATE_KEY',
          cause: err,
          connector: CONNECTOR_NAME,
        });
      }
      if (code === 26) {
        throw new NotFoundError(`MongoDB namespace not found: ${message}`, {
          cause: err,
          connector: CONNECTOR_NAME,
        });
      }
    }

    // Classify by MongoDB error class name
    if (errName === 'MongoNetworkError' || errName === 'MongoNetworkTimeoutError') {
      throw new ConnectionError(`MongoDB network error: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errName === 'MongoServerSelectionError') {
      throw new ConnectionError(`MongoDB server selection failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errName === 'MongoInvalidArgumentError') {
      throw new QueryError(`MongoDB invalid argument: ${message}`, {
        code: 'VENOMOUS_INVALID_QUERY',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // MongoBulkWriteError: check both top-level code and writeErrors for DuplicateKey
    if (errName === 'MongoBulkWriteError') {
      const writeErrors = (err as { writeErrors?: Array<{ code?: number }> }).writeErrors;
      const isDuplicateKey =
        (typeof code === 'number' && code === 11000) ||
        writeErrors?.some((we) => we.code === 11000);
      if (isDuplicateKey) {
        throw new QueryError(`MongoDB duplicate key: ${message}`, {
          code: 'VENOMOUS_DUPLICATE_KEY',
          cause: err,
          connector: CONNECTOR_NAME,
        });
      }
      // Non-DuplicateKey bulk write errors fall through to default QueryError
    }

    // Message-based fallback classification
    const upperMessage = message.toUpperCase();

    if (
      upperMessage.includes('ECONNREFUSED') ||
      upperMessage.includes('ETIMEDOUT') ||
      upperMessage.includes('ENOTFOUND')
    ) {
      throw new ConnectionError(`MongoDB connection error: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (upperMessage.includes('AUTHENTICATION') || upperMessage.includes('CREDENTIAL')) {
      throw new AuthenticationError(`MongoDB authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (upperMessage.includes('NOT AUTHORIZED') || upperMessage.includes('UNAUTHORIZED')) {
      throw new PermissionError(`MongoDB permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`MongoDB error: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  // Non-Error thrown
  throw new QueryError(`MongoDB error: ${defaultMessage}`, {
    connector: CONNECTOR_NAME,
  });
}
