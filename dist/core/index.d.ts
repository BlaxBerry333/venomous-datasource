//#region src/core/types/auth.d.ts
/**
 * BigQuery authentication options.
 *
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
type BigQueryAuth = {
  readonly type?: 'credentials';
  readonly credentials: object;
};
/**
 * Google Cloud Storage authentication options.
 *
 * Auto auth is not supported — explicit credentials are required.
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
type GoogleCloudStorageAuth = {
  readonly type?: 'credentials';
  readonly credentials: object;
};
/**
 * Google Sheets authentication options (discriminated union).
 * Same auth modes as Google Cloud Storage (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
type SheetsAuth = {
  readonly type: 'auto';
} | {
  readonly type?: 'credentials';
  readonly credentials: object;
};
/**
 * Firebase Firestore authentication options (discriminated union).
 * Same auth modes as BigQuery/Google Cloud Storage/Sheets (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
type FirestoreAuth = {
  readonly type: 'auto';
} | {
  readonly type?: 'credentials';
  readonly credentials: object;
};
/**
 * AWS S3 authentication options.
 *
 * The `type` field can be omitted (defaults to `'access-key'`).
 */
type AWSS3Auth = {
  readonly type?: 'access-key';
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
};
/**
 * Azure Blob Storage authentication options (discriminated union).
 */
type AzureBlobStorageAuth = {
  readonly type: 'connection-string';
  readonly connectionString: string;
} | {
  readonly type: 'sas-token';
  readonly accountName: string;
  readonly sasToken: string;
};
/**
 * MongoDB authentication options (discriminated union).
 *
 * Two modes:
 * - `connection-string`: User provides a full MongoDB URI (`mongodb://` or `mongodb+srv://`).
 * - `credentials`: User provides username/password/host, program constructs the URI.
 *
 * When omitted (`undefined`), connects to `mongodb://localhost:27017` (local dev).
 */
type MongoDBAuth = {
  readonly type: 'connection-string';
  readonly connectionString: string;
} | {
  readonly type: 'credentials';
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly port?: number;
  readonly authSource?: string;
};
/**
 * Union of all tabular data source auth types.
 */
type TabularAuth = BigQueryAuth | SheetsAuth;
/**
 * Union of all file data source auth types.
 */
type FileAuth = AWSS3Auth | GoogleCloudStorageAuth | AzureBlobStorageAuth;
/**
 * Union of all document data source auth types.
 */
type DocumentAuth = FirestoreAuth | MongoDBAuth; //#endregion
//#region src/core/types/pagination.d.ts

//# sourceMappingURL=auth.d.ts.map
/**
 * Options for paginated requests.
 */
interface PageOptions {
  /** Number of items per page. Default: 50, Max: 1000. */
  readonly size?: number;
  /** Opaque cursor returned from a previous request. */
  readonly cursor?: string;
}
/**
 * Paginated result container.
 * @typeParam T - The type of items in the result set.
 */
interface PageResult<T> {
  /** Items for the current page. */
  readonly data: T[];
  /** Opaque cursor for the next page. `undefined` when no more data. */
  readonly nextCursor?: string;
  /** Whether more pages are available. */
  readonly hasMore: boolean;
  /** Total count of items (not all data sources support this). */
  readonly total?: number;
}

//#endregion
//#region src/core/types/query.d.ts
//# sourceMappingURL=pagination.d.ts.map
/**
 * Supported comparison operators for WHERE clauses.
 */
type WhereOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'like';
/**
 * A single WHERE condition.
 *
 * The `value` type depends on the operator:
 * - `eq`, `ne`, `gt`, `lt`, `gte`, `lte`: `string | number | boolean | null`
 * - `in`: `unknown[]` (array of values)
 * - `like`: `string` (SQL LIKE pattern with `%` and `_` wildcards)
 *
 * Type validation is deferred to the connector at runtime.
 */
interface WhereCondition {
  readonly field: string;
  readonly operator: WhereOperator;
  readonly value: unknown;
}
/**
 * WHERE clause: an array of conditions combined with AND.
 * For OR logic, use `sql()` instead.
 */
type WhereClause = WhereCondition[];
/**
 * ORDER BY direction.
 */
type OrderDirection = 'asc' | 'desc';
/**
 * A single ORDER BY clause.
 */
interface OrderByClause {
  readonly field: string;
  readonly direction: OrderDirection;
}
/**
 * Options for `find()` queries.
 */
interface FindOptions {
  readonly where?: WhereClause;
  readonly orderBy?: OrderByClause[];
  readonly page?: PageOptions;
}
/**
 * Options for `peek()` preview.
 */
interface PeekOptions {
  /** Number of rows to preview. Default: 10. */
  readonly rows?: number;
}
/**
 * Options for `files()` listing.
 */
interface ListOptions {
  readonly page?: PageOptions;
}
/**
 * Options for `update()`.
 */
interface UpdateOptions {
  readonly where: WhereClause;
  readonly set: Record<string, unknown>;
}
/**
 * Options for `remove()` on tabular data.
 */
interface WhereOptions {
  readonly where: WhereClause;
}

//#endregion
//#region src/core/types/result.d.ts
//# sourceMappingURL=query.d.ts.map
/**
 * A single row of tabular data.
 */
type Row = Record<string, unknown>;
/**
 * Column metadata.
 */
interface ColumnInfo {
  /** Column name. */
  readonly name: string;
  /** Native type string from the data source. */
  readonly type: string;
  /** Whether the column allows NULL values. */
  readonly nullable: boolean;
  /** Optional description/comment for the column. */
  readonly description?: string;
}
/**
 * Table metadata.
 */
interface TableInfo {
  /** Table name. */
  readonly name: string;
  /** Column schema (not all data sources provide this eagerly). */
  readonly schema?: ColumnInfo[];
  /** Approximate row count (not all data sources support this). */
  readonly rowCount?: number;
}
/**
 * File metadata.
 */
interface FileInfo {
  /** File name (without directory path). */
  readonly name: string;
  /** Full path relative to bucket/container root. */
  readonly path: string;
  /** File size in bytes. */
  readonly size: number;
  /** Last modification timestamp. */
  readonly lastModified: Date;
  /** MIME type (if available). */
  readonly contentType?: string;
  /** Whether this entry is a directory/prefix. */
  readonly isDirectory: boolean;
}
/**
 * Result of a `peek()` operation.
 */
interface PeekResult {
  /** Preview rows. */
  readonly data: Row[];
  /** Column metadata (if available). */
  readonly columns?: ColumnInfo[];
  /** Total row count in the source (if available). */
  readonly totalRows?: number;
}
/**
 * Result of an `insert()` operation.
 */
interface InsertResult {
  /** Number of rows inserted. */
  readonly insertedCount: number;
}
/**
 * Result of an `update()` operation.
 */
interface UpdateResult {
  /** Number of rows updated. */
  readonly updatedCount: number;
}
/**
 * Result of a `remove()` operation on tabular data.
 */
interface DeleteResult {
  /** Number of rows deleted. */
  readonly deletedCount: number;
}
/**
 * Result of a `write()` operation on file data.
 */
interface WriteResult {
  /** Full path of the written file. */
  readonly path: string;
  /** Size of the written file in bytes. */
  readonly size: number;
}

//#endregion
//#region src/core/interfaces/tabular-connector.d.ts
//# sourceMappingURL=result.d.ts.map
/**
 * Interface for tabular (structured) data source connectors.
 *
 * Implementations: BigQuery, future MySQL/PostgreSQL/Google Sheets.
 *
 * @typeParam TAuth - Authentication type, must extend TabularAuth.
 *
 * @example
 * ```typescript
 * const connector: TabularConnector<BigQueryAuth> = createBigQueryConnector();
 * await connector.connect({ credentials: {...} });
 * const tables = await connector.tables();
 * const preview = await connector.peek('my_table', { rows: 5 });
 * await connector.disconnect();
 * ```
 */
interface TabularConnector<TAuth extends TabularAuth = TabularAuth> {
  /**
   * Connect to the data source and initialize the client.
   * Behavior when auth is omitted depends on the connector implementation.
   *
   * @param auth - Authentication configuration.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {ConnectionError} When the data source is unreachable.
   */
  connect(auth?: TAuth): Promise<void>;
  /**
   * Disconnect and release all resources.
   */
  disconnect(): Promise<void>;
  /**
   * List all available tables.
   *
   * @returns Array of table metadata.
   */
  tables(): Promise<TableInfo[]>;
  /**
   * Quick preview of the first N rows of a table.
   *
   * @param table - Table name.
   * @param options - Preview options (default: 10 rows).
   * @returns Preview result with data and optional column metadata.
   * @throws {NotFoundError} When the table does not exist.
   */
  peek(table: string, options?: PeekOptions): Promise<PeekResult>;
  /**
   * Conditional query with pagination support.
   *
   * @param table - Table name.
   * @param options - Query options (where, orderBy, page).
   * @returns Paginated result set.
   * @throws {QueryError} When the query is invalid.
   * @throws {NotFoundError} When the table does not exist.
   */
  find(table: string, options?: FindOptions): Promise<PageResult<Row>>;
  /**
   * Execute a native SQL query with parameterized values.
   * Returns an async iterable that yields rows one by one.
   *
   * @param query - Parameterized SQL query string (use `?` or `@param` placeholders).
   * @param params - Query parameter values.
   * @returns Async iterable of rows.
   * @throws {QueryError} When the query syntax is invalid or execution fails.
   */
  sql(query: string, params?: unknown[]): AsyncIterable<Row>;
  /**
   * Insert rows into a table (optional capability).
   *
   * @param table - Table name.
   * @param rows - Array of row objects to insert.
   * @returns Insert result with count.
   * @throws {PermissionError} When write access is denied.
   */
  insert?(table: string, rows: Row[]): Promise<InsertResult>;
  /**
   * Update rows matching a WHERE condition (optional capability).
   *
   * @param table - Table name.
   * @param options - Update options with where clause and set values.
   * @returns Update result with count.
   * @throws {PermissionError} When write access is denied.
   */
  update?(table: string, options: UpdateOptions): Promise<UpdateResult>;
  /**
   * Delete rows matching a WHERE condition (optional capability).
   *
   * @param table - Table name.
   * @param options - Where options specifying which rows to delete.
   * @returns Delete result with count.
   * @throws {PermissionError} When write access is denied.
   */
  remove?(table: string, options: WhereOptions): Promise<DeleteResult>;
}

//#endregion
//#region src/core/interfaces/file-connector.d.ts
//# sourceMappingURL=tabular-connector.d.ts.map
/**
 * Interface for file-based data source connectors.
 *
 * Implementations: AWS S3, Google Cloud Storage, Azure Blob Storage.
 *
 * @typeParam TAuth - Authentication type, must extend FileAuth.
 *
 * @example
 * ```typescript
 * const connector: FileConnector<AWSS3Auth> = createAWSS3Connector({ bucket: 'my-bucket' });
 * await connector.connect({ accessKeyId: '...', secretAccessKey: '...', region: 'us-east-1' });
 * const fileList = await connector.files('data/', { page: { size: 20 } });
 * const stream = await connector.read('data/report.csv');
 * await connector.disconnect();
 * ```
 */
interface FileConnector<TAuth extends FileAuth = FileAuth> {
  /**
   * Connect to the storage service and initialize the client.
   * Some connectors (e.g., Google Sheets, Firestore) default to
   * `{ type: 'auto' }` when no auth is provided. MongoDB defaults to
   * `localhost:27017` when no auth is provided. Others (AWS S3, Google Cloud
   * Storage, Azure Blob Storage) require explicit auth and will throw
   * `AuthenticationError` if auth is not provided.
   *
   * @param auth - Authentication configuration.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {ConnectionError} When the storage service is unreachable.
   */
  connect(auth?: TAuth): Promise<void>;
  /**
   * Disconnect and release all resources.
   */
  disconnect(): Promise<void>;
  /**
   * List files in a directory with pagination.
   *
   * @param path - Directory path (relative to bucket/container root). Defaults to root.
   * @param options - Listing options with pagination.
   * @returns Paginated list of file metadata.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>>;
  /**
   * Preview the content of a file (CSV/JSON first N rows).
   *
   * @param path - File path relative to bucket/container root.
   * @param options - Preview options (default: 10 rows).
   * @returns Preview result with data and optional column metadata.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  peek(path: string, options?: PeekOptions): Promise<PeekResult>;
  /**
   * Read a file and return its content as a ReadableStream.
   *
   * @param path - File path relative to bucket/container root.
   * @returns ReadableStream of file content.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * Get file metadata.
   *
   * @param path - File path relative to bucket/container root.
   * @returns File metadata.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  stat(path: string): Promise<FileInfo>;
  /**
   * Write data to a file (optional capability).
   *
   * @param path - File path relative to bucket/container root.
   * @param data - Data to write.
   * @returns Write result with path and size.
   * @throws {PermissionError} When write access is denied.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  write?(path: string, data: ReadableStream<Uint8Array> | Buffer | string): Promise<WriteResult>;
  /**
   * Delete a file (optional capability).
   *
   * Idempotent: deleting a non-existent file succeeds silently.
   *
   * @param path - File path relative to bucket/container root.
   * @throws {PermissionError} When write access is denied.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  remove?(path: string): Promise<void>;
}

//#endregion
//#region src/core/types/document.d.ts
//# sourceMappingURL=file-connector.d.ts.map
/**
 * A document read from a document database.
 * The `id` is always present and separated from the document data.
 */
interface Document {
  readonly id: string;
  readonly data: Record<string, unknown>;
}
/**
 * A document to be written to a document database.
 * The `id` is optional -- omit it to let the database auto-generate one.
 */
interface DocumentInput {
  readonly id?: string;
  readonly data: Record<string, unknown>;
}
/**
 * Collection metadata. Document databases are schema-less,
 * so only the name is available without sampling.
 */
interface CollectionInfo {
  readonly name: string;
}
/**
 * Field information inferred by sampling documents.
 * Unlike `ColumnInfo` (schema-enforced), these fields are best-effort
 * and may not be present in every document.
 */
interface FieldInfo {
  readonly name: string;
  /** Type string defined by each connector (e.g., 'STRING', 'NUMBER', 'TIMESTAMP'). */
  readonly type: string;
  /** Always `true` for document databases (any field can be absent in any document). */
  readonly nullable: boolean;
}
/**
 * Supported filter operators for document queries.
 * Does not include `like` -- document databases generally lack native LIKE support.
 */
type DocFilterOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in';
/**
 * A single filter condition for document queries.
 */
interface DocFilterCondition {
  readonly field: string;
  readonly operator: DocFilterOperator;
  readonly value: unknown;
}
/**
 * Filter conditions combined with AND logic.
 */
type DocFilter = DocFilterCondition[];
/**
 * A single ORDER BY clause for document queries.
 * Reuses the universal `OrderDirection` type.
 */
interface DocOrderByClause {
  readonly field: string;
  readonly direction: OrderDirection;
}
/**
 * Options for `find()` queries on document collections.
 */
interface DocFindOptions {
  readonly filter?: DocFilter;
  readonly orderBy?: DocOrderByClause[];
  readonly page?: PageOptions;
}
/**
 * Options for `peek()` preview on document collections.
 */
interface DocPeekOptions {
  /** Number of documents to preview. Default: 10. */
  readonly rows?: number;
}
/**
 * Result of a `peek()` operation on a document collection.
 */
interface DocPeekResult {
  /** Preview documents. */
  readonly data: Document[];
  /** Field information inferred by sampling (not guaranteed to cover all documents). */
  readonly fields?: FieldInfo[];
  /** Total document count (most document databases do not support efficient counting). */
  readonly totalDocs?: number;
}
/**
 * Result of an `insert()` operation on a document collection.
 */
interface DocInsertResult {
  /** Number of documents inserted. */
  readonly insertedCount: number;
  /** Actual document IDs used (user-specified or auto-generated). */
  readonly insertedIds: string[];
}
/**
 * Result of an `update()` operation on a document collection.
 */
interface DocUpdateResult {
  /** Number of documents updated. */
  readonly updatedCount: number;
}
/**
 * Result of a `remove()` operation on a document collection.
 */
interface DocDeleteResult {
  /** Number of documents deleted. */
  readonly deletedCount: number;
}
/**
 * Options for `update()` on a document collection.
 * `filter` is required and must be non-empty to prevent accidental mass updates.
 */
interface DocUpdateOptions {
  readonly filter: DocFilter;
  readonly set: Record<string, unknown>;
}
/**
 * Options for `remove()` on a document collection.
 * `filter` is required and must be non-empty to prevent accidental mass deletes.
 */
interface DocRemoveOptions {
  readonly filter: DocFilter;
}

//#endregion
//#region src/core/interfaces/document-connector.d.ts
//# sourceMappingURL=document.d.ts.map
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
interface DocumentConnector<TAuth extends DocumentAuth = DocumentAuth> {
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

//#endregion
//#region src/core/errors/base.d.ts
//# sourceMappingURL=document-connector.d.ts.map
/**
 * Base error class for all venomous-datasource errors.
 *
 * All errors include a machine-readable `code`, optional `connector` identifier,
 * and support for cause chaining. `toJSON()` automatically sanitizes sensitive
 * information from the output.
 *
 * @example
 * ```typescript
 * try {
 *   await connector.connect(auth);
 * } catch (err) {
 *   if (err instanceof VenomousError) {
 *     console.error(err.code, err.message);
 *     console.log(JSON.stringify(err)); // auto-sanitized
 *   }
 * }
 * ```
 */
declare class VenomousError extends Error {
  /** Machine-readable error code (e.g., `VENOMOUS_AUTH_FAILED`). */
  readonly code: string;
  /** Connector type that produced this error (e.g., `bigquery`, `aws-s3`). */
  readonly connector?: string;
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
  /**
   * Returns a sanitized JSON representation.
   * Sensitive information (auth credentials, full file paths in cause) is excluded.
   */
  toJSON(): Record<string, unknown>;
}

//#endregion
//#region src/core/errors/auth.d.ts
//# sourceMappingURL=base.d.ts.map
/**
 * Thrown when authentication fails (invalid credentials, expired tokens, etc.).
 */
declare class AuthenticationError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/errors/connection.d.ts
//# sourceMappingURL=auth.d.ts.map
/**
 * Thrown when a connection to the data source fails (network errors, service unreachable, etc.).
 */
declare class ConnectionError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/errors/query.d.ts
//# sourceMappingURL=connection.d.ts.map
/**
 * Thrown when a query fails (syntax error, execution failure, invalid cursor, etc.).
 */
declare class QueryError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/errors/path.d.ts
//# sourceMappingURL=query.d.ts.map
/**
 * Thrown when a file path is invalid (traversal attack, absolute path, encoding error, etc.).
 */
declare class PathError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/errors/not-found.d.ts
//# sourceMappingURL=path.d.ts.map
/**
 * Thrown when a requested resource (table, file, bucket) does not exist.
 */
declare class NotFoundError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/errors/permission.d.ts
//# sourceMappingURL=not-found.d.ts.map
/**
 * Thrown when the caller lacks sufficient permissions (IAM, ACL, etc.).
 */
declare class PermissionError extends VenomousError {
  constructor(message: string, options?: {
    code?: string;
    cause?: unknown;
    connector?: string;
  });
}

//#endregion
//#region src/core/utils/path.d.ts
//# sourceMappingURL=permission.d.ts.map

/**
 * Normalize and validate a file path for safe use with cloud storage APIs.
 *
 * Processing order:
 * 1. Single-pass URL decode (handles `..%2F` etc.)
 * 2. Convert Windows backslashes to forward slashes
 * 3. NFC Unicode normalization
 * 4. Security checks (traversal, absolute path, empty, length)
 * 5. Strip leading/trailing slashes
 *
 * @param path - User-provided file path.
 * @returns Normalized safe path.
 * @throws {PathError} When the path is unsafe or invalid.
 *
 * @remarks Callers MUST NOT apply additional URL decoding to the returned path.
 * This function performs a single-pass URL decode internally. If the returned
 * value is decoded again, double-encoded traversal sequences (e.g., `%252e%252e%252f`)
 * could become dangerous `../` patterns.
 *
 * @example
 * ```typescript
 * normalizePath('data/file.csv');           // 'data/file.csv'
 * normalizePath('/data/file.csv');          // throws PathError (absolute)
 * normalizePath('../etc/passwd');           // throws PathError (traversal)
 * normalizePath('data/日本語.csv');          // 'data/日本語.csv' (NFC normalized)
 * ```
 */
declare function normalizePath(path: string): string;
/**
 * Check whether a path is safe without throwing an exception.
 *
 * @param path - User-provided file path.
 * @returns `true` if the path is safe, `false` otherwise.
 */
declare function isPathSafe(path: string): boolean;
/**
 * Encode non-ASCII characters in a path using `encodeURIComponent`.
 * Preserves `/` separators and printable ASCII characters (0x20-0x7E).
 * Primarily used by the S3 connector, which requires CJK characters to be percent-encoded.
 *
 * @remarks Spaces (0x20) are NOT encoded by this function. If the target storage
 * SDK requires spaces to be encoded as `%20`, the caller should handle that separately.
 *
 * @param path - A normalized path (output of `normalizePath`).
 * @returns Path with non-ASCII characters percent-encoded.
 *
 * @example
 * ```typescript
 * encodeCJK('data/日本語ファイル.csv');
 * // 'data/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.csv'
 * ```
 */
declare function encodeCJK(path: string): string;

//#endregion
//#region src/core/utils/sanitize.d.ts
//# sourceMappingURL=path.d.ts.map
/**
 * Deep-clone an auth configuration object and replace sensitive field values
 * with `'[REDACTED]'`.
 *
 * @param auth - Any auth configuration object (or null/undefined/primitive).
 * @param additionalFields - Extra field names to redact beyond the defaults.
 * @returns A deep-cloned, redacted copy of the input.
 *
 * @example
 * ```typescript
 * const safe = redactAuth({
 *   type: 'access-key',
 *   accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
 *   secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
 *   region: 'us-east-1',
 * });
 * // { type: 'access-key', accessKeyId: '[REDACTED]', secretAccessKey: '[REDACTED]', region: 'us-east-1' }
 * ```
 */
declare function redactAuth(auth: unknown, additionalFields?: string[]): unknown;
declare function sanitizeError(error: unknown): Record<string, unknown>;

//#endregion
//#region src/core/utils/pagination.d.ts
//# sourceMappingURL=sanitize.d.ts.map
/**
 * Validate and clamp a page size to the allowed range [1, 1000].
 *
 * @param size - Requested page size.
 * @returns Object with the clamped value and whether it was modified.
 *
 * @example
 * ```typescript
 * validatePageSize(50);    // { value: 50, truncated: false }
 * validatePageSize(2000);  // { value: 1000, truncated: true }
 * validatePageSize(NaN);   // { value: 50, truncated: true }
 * validatePageSize(-5);    // { value: 1, truncated: true }
 * ```
 */
declare function validatePageSize(size: number): {
  value: number;
  truncated: boolean;
};
/**
 * Encode an internal pagination state object into an opaque cursor string.
 * The cursor includes a version number for future format upgrades.
 *
 * @param state - Internal pagination state to encode.
 * @returns Base64url-encoded cursor string.
 *
 * @example
 * ```typescript
 * const cursor = encodeCursor({ pageToken: 'abc123', offset: 50 });
 * // Returns an opaque base64url string
 * ```
 */
declare function encodeCursor(state: Record<string, unknown>): string;
/**
 * Decode an opaque cursor string back into an internal pagination state object.
 *
 * @param cursor - Previously encoded cursor string.
 * @returns Decoded pagination state (without the version field).
 * @throws {QueryError} When the cursor is invalid (bad base64, invalid JSON, wrong version).
 *
 * @example
 * ```typescript
 * const state = decodeCursor(cursor);
 * // { pageToken: 'abc123', offset: 50 }
 * ```
 */
declare function decodeCursor(cursor: string): Record<string, unknown>;

//#endregion
//#region src/core/utils/parsers.d.ts
//# sourceMappingURL=pagination.d.ts.map
/**
 * Parse a CSV string according to RFC 4180.
 * Handles: quoted fields, commas inside quotes, newlines inside quotes, escaped quotes ("").
 *
 * @param content - Raw CSV string content.
 * @param maxRows - Maximum number of data rows to return (excluding header).
 * @returns Object with columns and data rows.
 */
declare function parseCsv(content: string, maxRows: number): {
  columns: ColumnInfo[];
  data: Row[];
};
/**
 * Parse JSON content for peek.
 * Supports JSON arrays and JSONL (newline-delimited JSON).
 *
 * Security: JSON.parse errors are not propagated as cause to avoid
 * leaking file content in error messages.
 */
declare function parseJson(content: string, maxRows: number): {
  data: Row[];
};
/**
 * Determine file format from extension.
 */
declare function getFileFormat(path: string): 'csv' | 'json' | 'jsonl' | null;

//#endregion
//# sourceMappingURL=parsers.d.ts.map

export { AWSS3Auth, AuthenticationError, AzureBlobStorageAuth, BigQueryAuth, CollectionInfo, ColumnInfo, ConnectionError, DeleteResult, DocDeleteResult, DocFilter, DocFilterCondition, DocFilterOperator, DocFindOptions, DocInsertResult, DocOrderByClause, DocPeekOptions, DocPeekResult, DocRemoveOptions, DocUpdateOptions, DocUpdateResult, Document, DocumentAuth, DocumentConnector, DocumentInput, FieldInfo, FileAuth, FileConnector, FileInfo, FindOptions, FirestoreAuth, GoogleCloudStorageAuth, InsertResult, ListOptions, MongoDBAuth, NotFoundError, OrderByClause, OrderDirection, PageOptions, PageResult, PathError, PeekOptions, PeekResult, PermissionError, QueryError, Row, SheetsAuth, TableInfo, TabularAuth, TabularConnector, UpdateOptions, UpdateResult, VenomousError, WhereClause, WhereCondition, WhereOperator, WhereOptions, WriteResult, decodeCursor, encodeCJK, encodeCursor, getFileFormat, isPathSafe, normalizePath, parseCsv, parseJson, redactAuth, sanitizeError, validatePageSize };
//# sourceMappingURL=index.d.ts.map