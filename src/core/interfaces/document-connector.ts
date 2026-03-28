import type { DocumentAuth } from '../types/auth.js';
import type { PageResult } from '../types/pagination.js';
import type {
  Document,
  DocumentInput,
  CollectionInfo,
  DocFindOptions,
  DocPeekOptions,
  DocPeekResult,
  DocInsertResult,
  DocUpdateResult,
  DocDeleteResult,
  DocUpdateOptions,
  DocRemoveOptions,
} from '../types/document.js';

/**
 * Interface for document-based data source connectors.
 *
 * Maps the collection/document model naturally, without forcing
 * relational (table/row) abstractions onto document databases.
 *
 * Implementations: Firestore, future MongoDB/DynamoDB/CouchDB.
 *
 * @typeParam TAuth - Authentication type, must extend DocumentAuth.
 *
 * @example
 * ```typescript
 * const connector: DocumentConnector<FirestoreAuth> = createFirestoreConnector();
 * await connector.connect({ type: 'auto' });
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 * const doc = await connector.getById('users', 'user123');
 * await connector.disconnect();
 * ```
 */
export interface DocumentConnector<TAuth extends DocumentAuth = DocumentAuth> {
  /**
   * Connect to the document database and initialize the client.
   * If no auth is provided, behavior depends on the connector implementation.
   * Idempotent: if already connected, disconnects first then reconnects.
   *
   * @param auth - Authentication configuration.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {ConnectionError} When the data source is unreachable.
   * @throws {PermissionError} When the credentials lack sufficient permissions.
   */
  connect(auth?: TAuth): Promise<void>;

  /**
   * Disconnect and release all resources.
   * Idempotent: calling on an already-disconnected connector is a no-op.
   */
  disconnect(): Promise<void>;

  /**
   * List all top-level collections.
   *
   * @returns Array of collection metadata (name only -- document databases are schema-less).
   */
  collections(): Promise<CollectionInfo[]>;

  /**
   * Preview the first N documents of a collection and infer field information.
   *
   * @param collection - Collection path (supports subcollections, e.g., `'users/uid123/orders'`).
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
   * @throws {QueryError} When the query is invalid (e.g., requires a composite index).
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
   * Insert documents into a collection (optional capability).
   *
   * Uses WriteBatch internally (max 500 per batch). Multi-batch operations
   * are NOT atomic -- if a later batch fails, earlier batches are not rolled back.
   *
   * @param collection - Collection path.
   * @param docs - Array of documents to insert. Each may specify an `id` or omit it for auto-generation.
   * @returns Insert result with count and actual IDs used.
   * @throws {QueryError} When a document ID is invalid (empty or contains `/`).
   * @throws {PermissionError} When write access is denied.
   */
  insert?(collection: string, docs: DocumentInput[]): Promise<DocInsertResult>;

  /**
   * Update documents matching a filter (optional capability).
   *
   * Uses WriteBatch internally. The filter must be non-empty to prevent
   * accidental mass updates.
   *
   * @param collection - Collection path.
   * @param options - Update options with filter and set values.
   * @returns Update result with count.
   * @throws {QueryError} When the filter is empty (`VENOMOUS_EMPTY_FILTER`).
   * @throws {PermissionError} When write access is denied.
   */
  update?(collection: string, options: DocUpdateOptions): Promise<DocUpdateResult>;

  /**
   * Delete documents matching a filter (optional capability).
   *
   * Uses WriteBatch internally. The filter must be non-empty to prevent
   * accidental mass deletes.
   *
   * @param collection - Collection path.
   * @param options - Remove options with filter.
   * @returns Delete result with count.
   * @throws {QueryError} When the filter is empty (`VENOMOUS_EMPTY_FILTER`).
   * @throws {PermissionError} When write access is denied.
   */
  remove?(collection: string, options: DocRemoveOptions): Promise<DocDeleteResult>;
}
