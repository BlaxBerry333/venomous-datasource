import type { TabularAuth } from '../types/auth.js';
import type { PageResult } from '../types/pagination.js';
import type { FindOptions, PeekOptions, UpdateOptions, WhereOptions } from '../types/query.js';
import type {
  Row,
  TableInfo,
  PeekResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
} from '../types/result.js';

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
 * await connector.connect({ type: 'auto' });
 * const tables = await connector.tables();
 * const preview = await connector.peek('my_table', { rows: 5 });
 * await connector.disconnect();
 * ```
 */
export interface TabularConnector<TAuth extends TabularAuth = TabularAuth> {
  /**
   * Connect to the data source and initialize the client.
   * If no auth is provided, defaults to `{ type: 'auto' }`.
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
