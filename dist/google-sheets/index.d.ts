import { DeleteResult, FindOptions, InsertResult, PageResult, PeekOptions, PeekResult, Row, SheetsAuth, SheetsAuth as SheetsAuth$1, TableInfo, TabularConnector, UpdateOptions, UpdateResult, WhereOptions } from "../core/index.js";

//#region src/google-sheets/types.d.ts
/**
* Google Sheets connector connection options.
*/
/**
 * Google Sheets connector connection options.
 */
interface SheetsOptions {
  /**
   * Google Spreadsheet ID.
   * Extract from URL: `https://docs.google.com/spreadsheets/d/{spreadsheetId}/...`
   */
  readonly spreadsheetId: string;
  /**
   * Header row number (1-based). Defaults to 1.
   * Set to 0 for no header row (columns will use A/B/C... naming).
   */
  readonly headerRow?: number;
} //#endregion
//#region src/google-sheets/connector.d.ts

//# sourceMappingURL=types.d.ts.map

/**
 * SheetsConnector implements TabularConnector for Google Sheets.
 *
 * Maps a Google Spreadsheet to a tabular data source where each worksheet (sheet)
 * is a "table". Uses the Google Sheets API v4 via the `googleapis` package.
 *
 * **Important limitations:**
 * - `sql()` is not supported (throws `QueryError`). Use `find()` for filtered queries.
 * - `find()`, `update()`, and `remove()` use client-side filtering (Sheets API does
 *   not support server-side queries). Performance degrades with large datasets.
 * - `update()` and `remove()` use read-modify-write patterns. Concurrent writes
 *   to the same sheet are not safe.
 *
 * @example
 * ```typescript
 * import { createSheetsConnector } from 'venomous-datasource/google-sheets';
 *
 * const connector = createSheetsConnector({
 *   spreadsheetId: 'abc123...',
 * });
 * await connector.connect(); // uses ADC
 * const sheets = await connector.tables();
 * const preview = await connector.peek(sheets[0].name, { rows: 5 });
 * await connector.disconnect();
 * ```
 */
declare class SheetsConnector implements TabularConnector<SheetsAuth$1> {
  private readonly options;
  private readonly headerRow;
  private client;
  private connected;
  /** Cached schema per sheet name (includes original column indices). */
  private schemaCache;
  constructor(options: SheetsOptions);
  /**
   * Ensure the connector is connected.
   * @throws {ConnectionError} if not connected.
   */
  private ensureConnected;
  /**
   * Connect to Google Sheets, initializing the API client.
   *
   * Validates the spreadsheetId by calling `spreadsheets.get`.
   * Calling `connect()` on an already-connected instance will disconnect first (idempotent).
   *
   * Note: The connector does not retain a reference to the `auth` object after creating
   * the `GoogleAuth` instance. However, the caller's auth object is not modified or
   * sanitized -- if the caller retains a reference, credentials remain in their memory.
   *
   * @param auth - Auth configuration (defaults to auto/ADC if undefined).
   * @throws {ConnectionError} if connection fails.
   * @throws {AuthenticationError} if credentials are invalid.
   * @throws {NotFoundError} if spreadsheetId is invalid.
   */
  connect(auth?: SheetsAuth$1): Promise<void>;
  disconnect(): Promise<void>;
  tables(): Promise<TableInfo[]>;
  /**
   * Read raw header row from a sheet.
   * Returns array of header strings (empty cells use column letter).
   */
  private readHeaders;
  /**
   * Infer schema for a sheet by sampling effectiveFormat of first N data rows.
   * Results are cached in schemaCache.
   */
  private inferSchema;
  /**
   * Read all data rows from a sheet, with type conversion based on schema.
   * Skips empty rows. Returns parsed rows and a mapping from data row index
   * to raw (0-based) row index in the sheet data area, so callers can compute
   * the actual sheet row number without a second API call.
   */
  private readAllRows;
  /**
   * Parse raw value arrays into Row objects, applying type conversion.
   * Skips empty rows (all cells null/empty).
   */
  private parseRows;
  /**
   * Convert a raw cell value to the appropriate JS type based on column type.
   */
  private convertValue;
  peek(table: string, options?: PeekOptions): Promise<PeekResult>;
  /**
   * Conditional query with client-side filtering and pagination.
   *
   * **Warning:** This method loads all data from the sheet into memory for
   * client-side filtering. For sheets with more than 50,000 rows, performance
   * may be significantly impacted.
   *
   * @param table - Sheet name.
   * @param options - Query options (where, orderBy, page).
   * @returns Paginated result set.
   * @throws {QueryError} When the query is invalid.
   * @throws {NotFoundError} When the sheet does not exist.
   */
  find(table: string, options?: FindOptions): Promise<PageResult<Row>>;
  /**
   * Google Sheets does not support SQL queries.
   * Use `find()` for filtered queries.
   *
   * @throws {QueryError} Always throws with code `VENOMOUS_NOT_SUPPORTED`.
   */
  sql(_query: string, _params?: unknown[]): AsyncIterable<Row>;
  /**
   * Append rows to a sheet using `spreadsheets.values.append`.
   *
   * @param table - Sheet name.
   * @param rows - Array of row objects to insert.
   * @returns Insert result with count.
   * @throws {PermissionError} When write access is denied.
   */
  insert(table: string, rows: Row[]): Promise<InsertResult>;
  /**
   * Update rows matching a WHERE condition.
   *
   * **Warning:** This method reads all data, matches rows client-side, then
   * updates matched rows via batch update. Not safe for concurrent writes.
   *
   * @param table - Sheet name.
   * @param options - Update options with where clause and set values.
   * @returns Update result with count.
   * @throws {QueryError} When WHERE is empty (prevents full-table update).
   * @throws {PermissionError} When write access is denied.
   */
  update(table: string, options: UpdateOptions): Promise<UpdateResult>;
  /**
   * Delete rows matching a WHERE condition.
   *
   * **Warning:** This method reads all data, matches rows client-side, then
   * deletes matched rows in reverse order (to avoid row number shifts).
   * Not safe for concurrent writes.
   *
   * @param table - Sheet name.
   * @param options - Where options specifying which rows to delete.
   * @returns Delete result with count.
   * @throws {QueryError} When WHERE is empty (prevents full-table delete).
   * @throws {PermissionError} When write access is denied.
   */
  remove(table: string, options: WhereOptions): Promise<DeleteResult>;
} //#endregion
//#region src/google-sheets/index.d.ts

//# sourceMappingURL=connector.d.ts.map
/**
 * Create a Google Sheets connector instance.
 *
 * @param options - Connection options (spreadsheetId, headerRow).
 * @returns An unconnected SheetsConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createSheetsConnector } from 'venomous-datasource/google-sheets';
 *
 * const connector = createSheetsConnector({
 *   spreadsheetId: 'abc123def456...',
 * });
 * await connector.connect(); // uses ADC
 * const sheets = await connector.tables();
 * const preview = await connector.peek(sheets[0].name, { rows: 5 });
 * await connector.disconnect();
 * ```
 */
declare function createSheetsConnector(options: SheetsOptions): SheetsConnector;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { SheetsAuth, SheetsConnector, SheetsOptions, createSheetsConnector };
//# sourceMappingURL=index.d.ts.map