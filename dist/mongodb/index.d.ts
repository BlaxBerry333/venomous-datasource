import { CollectionInfo, DocDeleteResult, DocFindOptions, DocInsertResult, DocPeekOptions, DocPeekResult, DocRemoveOptions, DocUpdateOptions, DocUpdateResult, Document, DocumentConnector, DocumentInput, MongoDBAuth, MongoDBAuth as MongoDBAuth$1, PageResult } from "../core/index.js";

//#region src/mongodb/types.d.ts
/**
* Options for creating a MongoDB connector.
*/
/**
 * Options for creating a MongoDB connector.
 */
interface MongoDBOptions {
  /** Database name. Required -- MongoDB operations are bound to a specific database. */
  readonly database: string;
  /** Connection timeout in milliseconds. Default: 10000. */
  readonly connectTimeoutMS?: number;
  /** Server selection timeout in milliseconds. Default: 10000. */
  readonly serverSelectionTimeoutMS?: number;
} //#endregion
//#region src/mongodb/connector.d.ts

//# sourceMappingURL=types.d.ts.map

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
 * await connector.connect();
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 * const doc = await connector.getById('users', '507f1f77bcf86cd799439011');
 *
 * await connector.disconnect();
 * ```
 */
declare class MongoDBConnector implements DocumentConnector<MongoDBAuth$1> {
  private readonly options;
  private client;
  private db;
  private connected;
  private schemaCache;
  constructor(options: MongoDBOptions);
  /**
   * Connect to MongoDB and initialize the client.
   * Idempotent: if already connected, disconnects first then reconnects.
   *
   * @param auth - Authentication configuration. When omitted, connects to localhost:27017.
   * @throws {ConnectionError} When mongodb SDK is not installed or connection fails.
   * @throws {AuthenticationError} When credentials are invalid.
   */
  connect(auth?: MongoDBAuth$1): Promise<void>;
  /**
   * Disconnect from MongoDB and release all resources.
   * Idempotent: calling on an already-disconnected connector is a no-op.
   */
  disconnect(): Promise<void>;
  /**
   * List all collections in the database.
   * Filters out `system.*` collections and views.
   *
   * @returns Array of collection metadata (name only).
   */
  collections(): Promise<CollectionInfo[]>;
  /**
   * Preview the first N documents of a collection and infer field information.
   *
   * @param collection - Collection name.
   * @param options - Preview options (default: 10 documents).
   * @returns Preview result with documents and optional inferred field info.
   */
  peek(collection: string, options?: DocPeekOptions): Promise<DocPeekResult>;
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
  find(collection: string, options?: DocFindOptions): Promise<PageResult<Document>>;
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
  getById(collection: string, id: string): Promise<Document | null>;
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
  insert(collection: string, docs: DocumentInput[]): Promise<DocInsertResult>;
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
  update(collection: string, options: DocUpdateOptions): Promise<DocUpdateResult>;
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
  remove(collection: string, options: DocRemoveOptions): Promise<DocDeleteResult>;
  /**
   * Ensure the connector is connected. Throws if not.
   */
  private ensureConnected;
} //#endregion
//#region src/mongodb/index.d.ts

//# sourceMappingURL=connector.d.ts.map
/**
 * Create a MongoDB connector instance.
 *
 * @param options - Connection options. `database` is required.
 * @returns An unconnected MongoDBConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createMongoDBConnector } from 'venomous-datasource/mongodb';
 *
 * const connector = createMongoDBConnector({ database: 'mydb' });
 * await connector.connect();
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 *
 * await connector.disconnect();
 * ```
 */
declare function createMongoDBConnector(options: MongoDBOptions): MongoDBConnector;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { MongoDBAuth, MongoDBConnector, MongoDBOptions, createMongoDBConnector };
//# sourceMappingURL=index.d.ts.map