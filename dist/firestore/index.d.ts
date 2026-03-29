import { CollectionInfo, DocDeleteResult, DocFindOptions, DocInsertResult, DocPeekOptions, DocPeekResult, DocRemoveOptions, DocUpdateOptions, DocUpdateResult, Document, DocumentConnector, DocumentInput, FirestoreAuth, FirestoreAuth as FirestoreAuth$1, PageResult } from "../core/index.js";

//#region src/firestore/types.d.ts
/**
* Options for creating a Firestore connector.
*/
/**
 * Options for creating a Firestore connector.
 */
interface FirestoreOptions {
  /** GCP project ID. Can be inferred from service account credentials. */
  readonly projectId?: string;
  /** Firestore database ID. Defaults to `'(default)'`. */
  readonly databaseId?: string;
} //#endregion
//#region src/firestore/connector.d.ts
//# sourceMappingURL=types.d.ts.map

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
declare class FirestoreConnector implements DocumentConnector<FirestoreAuth$1> {
  private readonly options;
  private app;
  private db;
  private connected;
  private schemaCache;
  constructor(options?: FirestoreOptions);
  /**
   * Connect to Firestore and initialize the client.
   * Idempotent: if already connected, disconnects first then reconnects.
   *
   * @param auth - Authentication configuration. Defaults to `{ type: 'auto' }`.
   * @throws {ConnectionError} When firebase-admin is not installed or connection fails.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {PermissionError} When credentials lack sufficient permissions.
   */
  connect(auth?: FirestoreAuth$1): Promise<void>;
  /**
   * Disconnect from Firestore and release all resources.
   * Idempotent: calling on an already-disconnected connector is a no-op.
   */
  disconnect(): Promise<void>;
  /**
   * List all top-level collections.
   *
   * @returns Array of collection metadata (name only).
   */
  collections(): Promise<CollectionInfo[]>;
  /**
   * Preview the first N documents of a collection and infer field information.
   *
   * @param collection - Collection path (supports subcollections).
   * @param options - Preview options (default: 10 documents).
   * @returns Preview result with documents and optional inferred field info.
   */
  peek(collection: string, options?: DocPeekOptions): Promise<DocPeekResult>;
  /**
   * Query documents with filtering, ordering, and pagination.
   *
   * @param collection - Collection path.
   * @param options - Query options (filter, orderBy, page).
   * @returns Paginated result set of documents.
   * @throws {QueryError} When the query is invalid.
   */
  find(collection: string, options?: DocFindOptions): Promise<PageResult<Document>>;
  /**
   * Get a single document by its ID.
   *
   * @param collection - Collection path.
   * @param id - Document ID (must not be empty or contain `/`).
   * @returns The document, or `null` if it does not exist.
   * @throws {QueryError} When the ID is invalid.
   */
  getById(collection: string, id: string): Promise<Document | null>;
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
  insert(collection: string, docs: DocumentInput[]): Promise<DocInsertResult>;
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
  update(collection: string, options: DocUpdateOptions): Promise<DocUpdateResult>;
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
  remove(collection: string, options: DocRemoveOptions): Promise<DocDeleteResult>;
  /**
   * Ensure the connector is connected. Throws if not.
   */
  private ensureConnected;
} //#endregion
//#region src/firestore/index.d.ts

//# sourceMappingURL=connector.d.ts.map
/**
 * Create a Firestore connector instance.
 *
 * @param options - Connection options (projectId, databaseId). All fields are optional.
 * @returns An unconnected FirestoreConnector. Call `connect()` before use.
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
 *
 * await connector.disconnect();
 * ```
 */
declare function createFirestoreConnector(options?: FirestoreOptions): FirestoreConnector;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { FirestoreAuth, FirestoreConnector, FirestoreOptions, createFirestoreConnector };
//# sourceMappingURL=index.d.ts.map