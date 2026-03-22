import type {
  TabularConnector,
  SheetsAuth,
  TableInfo,
  ColumnInfo,
  PeekResult,
  PeekOptions,
  FindOptions,
  UpdateOptions,
  WhereOptions,
  Row,
  PageResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  WhereClause,
  WhereCondition,
  OrderByClause,
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
import type { SheetsOptions } from './types.js';

const CONNECTOR_NAME = 'google-sheets';
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1000;
const DEFAULT_PAGE_SIZE = 50;
const SCHEMA_SAMPLE_ROWS = 100;
const LARGE_DATASET_WARNING_THRESHOLD = 50_000;

/** Sentinel row number for reading "all remaining rows" in A1 notation ranges. */
const MAX_SHEET_ROW = 999_999_999;

/**
 * Sheets epoch: 1899-12-30T00:00:00Z.
 * Google Sheets uses a serial number system based on this date.
 */
const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

// ── Sheets API types (minimal subset to avoid importing full googleapis types) ──

interface SheetsClient {
  spreadsheets: {
    get: (params: Record<string, unknown>) => Promise<{ data: SpreadsheetData }>;
    values: {
      get: (params: Record<string, unknown>) => Promise<{ data: ValuesData }>;
      append: (params: Record<string, unknown>) => Promise<{ data: AppendData }>;
      batchUpdate: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
    };
    batchUpdate: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  };
}

interface SpreadsheetData {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: SheetData[];
}

interface SheetData {
  properties?: {
    sheetId?: number;
    title?: string;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
  data?: GridData[];
}

interface GridData {
  rowData?: RowData[];
}

interface RowData {
  values?: CellData[];
}

interface CellData {
  effectiveValue?: {
    numberValue?: number;
    stringValue?: string;
    boolValue?: boolean;
    formulaValue?: string;
    errorValue?: { type?: string; message?: string };
  };
  effectiveFormat?: {
    numberFormat?: {
      type?: string;
    };
  };
}

interface ValuesData {
  values?: unknown[][];
}

interface AppendData {
  updates?: {
    updatedRows?: number;
  };
}

// ── Error handling ──

/**
 * Map Google Sheets API errors to appropriate VenomousError subclasses.
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof Error) {
    const message = err.message || defaultMessage;
    const errCode = (err as { code?: number | string }).code;

    // Classify by HTTP status code first
    if (errCode === 401) {
      throw new AuthenticationError(`Sheets authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errCode === 403) {
      throw new PermissionError(`Sheets permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errCode === 404) {
      throw new NotFoundError(message, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errCode === 429) {
      // Extract retryAfter if available
      const retryAfter = (err as { retryAfter?: string | number }).retryAfter;
      const retryInfo = retryAfter != null ? ` Retry after: ${retryAfter}` : '';
      throw new QueryError(`Sheets API rate limit exceeded: ${message}${retryInfo}`, {
        code: 'VENOMOUS_RATE_LIMITED',
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Fall back to message-based classification
    if (message.includes('PERMISSION_DENIED')) {
      throw new PermissionError(`Sheets permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (
      message.includes('Could not load the default credentials') ||
      message.includes('invalid_grant') ||
      message.includes('UNAUTHENTICATED') ||
      message.includes('credentials are required') ||
      message.includes('credentials are not valid')
    ) {
      throw new AuthenticationError(`Sheets authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('network error') ||
      message.includes('Network Error')
    ) {
      throw new ConnectionError(`Sheets connection failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`Sheets query failed: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}

// ── Sheet name escaping ──

/**
 * Escape a sheet name for use in A1 notation ranges.
 * If the name contains spaces or special characters, wrap in single quotes.
 * Single quotes within the name are escaped by doubling.
 */
function escapeSheetName(name: string): string {
  // Always wrap in quotes to be safe - the API accepts this for all names
  const escaped = name.replace(/'/g, "''");
  return `'${escaped}'`;
}

// ── Column name utilities ──

/**
 * Generate an Excel-style column letter from a 0-based column index.
 * 0 -> A, 1 -> B, ..., 25 -> Z, 26 -> AA, 27 -> AB, ...
 */
function columnIndexToLetter(index: number): string {
  let result = '';
  let remaining = index;
  do {
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return result;
}

/**
 * De-duplicate header names by appending _2, _3, etc. for duplicates.
 */
function deduplicateHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  const result: string[] = [];

  for (const header of headers) {
    const count = counts.get(header) ?? 0;
    counts.set(header, count + 1);
    if (count === 0) {
      result.push(header);
    } else {
      result.push(`${header}_${count + 1}`);
    }
  }

  return result;
}

// ── Date conversion ──

/**
 * Convert a Sheets serial number to an ISO date string (YYYY-MM-DD).
 */
function serialToDate(serial: number): string {
  const ms = SHEETS_EPOCH + Math.floor(serial) * MS_PER_DAY;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert a Sheets serial number (fractional part) to an ISO time string (HH:mm:ss).
 */
function serialToTime(serial: number): string {
  const fraction = serial - Math.floor(serial);
  const totalSeconds = Math.round(fraction * 86400);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Convert a Sheets serial number to an ISO datetime string (YYYY-MM-DDTHH:mm:ss).
 */
function serialToDateTime(serial: number): string {
  return `${serialToDate(serial)}T${serialToTime(serial)}`;
}

// ── Client-side filtering engine ──

/**
 * Check if a single row matches a WHERE condition.
 * Shared by find(), update(), and remove().
 */
function matchCondition(value: unknown, condition: WhereCondition): boolean {
  switch (condition.operator) {
    case 'eq':
      if (condition.value === null) {
        return value === null || value === undefined;
      }
      return value === condition.value;

    case 'ne':
      if (condition.value === null) {
        return value !== null && value !== undefined;
      }
      return value !== condition.value;

    case 'gt':
      if (value === null || value === undefined) return false;
      return (value as number | string) > (condition.value as number | string);

    case 'lt':
      if (value === null || value === undefined) return false;
      return (value as number | string) < (condition.value as number | string);

    case 'gte':
      if (value === null || value === undefined) return false;
      return (value as number | string) >= (condition.value as number | string);

    case 'lte':
      if (value === null || value === undefined) return false;
      return (value as number | string) <= (condition.value as number | string);

    case 'in': {
      const arr = condition.value as unknown[];
      return arr.includes(value);
    }

    case 'like': {
      if (value === null || value === undefined) return false;
      const pattern = condition.value as string;
      // Convert SQL LIKE pattern to regex using a clear three-step approach:
      // 1. Replace % and _ with unique placeholders to protect them from escaping
      const PERCENT_PH = '\x00PCT\x00';
      const UNDERSCORE_PH = '\x00USC\x00';
      const withPlaceholders = pattern.replace(/%/g, PERCENT_PH).replace(/_/g, UNDERSCORE_PH);
      // 2. Escape all remaining regex special characters
      const escaped = withPlaceholders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 3. Replace placeholders with regex equivalents
      const regexStr = escaped
        .replace(new RegExp(PERCENT_PH.replace(/\x00/g, '\\x00'), 'g'), '.*')
        .replace(new RegExp(UNDERSCORE_PH.replace(/\x00/g, '\\x00'), 'g'), '.');
      const regex = new RegExp(`^${regexStr}$`, 'i');
      return regex.test(String(value));
    }

    default: {
      const _exhaustive: never = condition.operator;
      throw new QueryError(`Unsupported operator: "${String(_exhaustive)}"`, {
        code: 'VENOMOUS_UNSUPPORTED_OPERATOR',
        connector: CONNECTOR_NAME,
      });
    }
  }
}

/**
 * Check if a row matches all conditions in a WHERE clause (AND logic).
 */
function matchRow(row: Row, where: WhereClause): boolean {
  return where.every((condition) => matchCondition(row[condition.field], condition));
}

/**
 * Apply a WHERE clause to filter rows. Shared by find(), update(), and remove().
 */
function applyWhere(rows: Row[], where?: WhereClause): Row[] {
  if (!where || where.length === 0) return rows;
  return rows.filter((row) => matchRow(row, where));
}

/**
 * Apply ORDER BY clauses to sort rows.
 */
function applyOrderBy(rows: Row[], orderBy?: OrderByClause[]): Row[] {
  if (!orderBy || orderBy.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const aVal = a[clause.field];
      const bVal = b[clause.field];

      // Handle nulls: nulls sort last
      if (aVal === null || aVal === undefined) {
        if (bVal === null || bVal === undefined) continue;
        return clause.direction === 'asc' ? 1 : -1;
      }
      if (bVal === null || bVal === undefined) {
        return clause.direction === 'asc' ? -1 : 1;
      }

      let cmp: number;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }

      if (cmp !== 0) {
        return clause.direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

// ── Type inference ──

/**
 * Infer a ColumnInfo type string from Sheets effectiveFormat numberFormat type.
 */
function inferColumnType(formatType: string | undefined): string {
  switch (formatType) {
    case 'NUMBER':
    case 'CURRENCY':
    case 'PERCENT':
      return 'NUMBER';
    case 'DATE':
      return 'DATE';
    case 'TIME':
      return 'TIME';
    case 'DATE_TIME':
      return 'DATETIME';
    case 'TEXT':
      return 'STRING';
    default:
      return 'STRING';
  }
}

// ── Internal schema with original column indices ──

/**
 * Extended column info that tracks the original column index in the raw data.
 * Used internally to correctly map columns when empty columns are skipped.
 */
interface InternalColumnInfo extends ColumnInfo {
  /** 0-based column index in the original sheet data. */
  readonly originalIndex: number;
}

/** Strip internal fields (originalIndex) from schema before returning to public API. */
function toPublicSchema(schema: InternalColumnInfo[]): ColumnInfo[] {
  return schema.map(({ name, type, nullable }) => ({ name, type, nullable }));
}

// ── SheetsConnector ──

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
export class SheetsConnector implements TabularConnector<SheetsAuth> {
  private readonly options: SheetsOptions;
  private readonly headerRow: number;
  private client: SheetsClient | null = null;
  private connected = false;

  /** Cached schema per sheet name (includes original column indices). */
  private schemaCache = new Map<string, InternalColumnInfo[]>();

  constructor(options: SheetsOptions) {
    this.options = options;
    this.headerRow = options.headerRow ?? 1;
  }

  /**
   * Ensure the connector is connected.
   * @throws {ConnectionError} if not connected.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.client) {
      throw new ConnectionError('Not connected. Call connect() first.', {
        code: 'VENOMOUS_NOT_CONNECTED',
        connector: CONNECTOR_NAME,
      });
    }
  }

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
  async connect(auth?: SheetsAuth): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }

    let google: typeof import('googleapis');
    try {
      google = await import('googleapis');
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        ((err as { code?: string }).code === 'MODULE_NOT_FOUND' ||
          (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      ) {
        throw new ConnectionError(
          'googleapis is required for the Sheets connector. Install it with: npm install googleapis',
          { code: 'VENOMOUS_MISSING_DEPENDENCY', connector: CONNECTOR_NAME }
        );
      }
      throw err;
    }

    const authConfig = resolveAuth(auth);
    const googleAuth = new google.google.auth.GoogleAuth(authConfig);

    const sheets = google.google.sheets({ version: 'v4', auth: googleAuth });
    this.client = sheets as unknown as SheetsClient;

    // Validate connection with lightweight metadata request
    try {
      await this.client.spreadsheets.get({
        spreadsheetId: this.options.spreadsheetId,
        fields: 'spreadsheetId,properties.title',
      });
    } catch (err) {
      this.client = null;
      wrapError(err, `Failed to connect to spreadsheet "${this.options.spreadsheetId}"`);
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.connected = false;
    this.schemaCache.clear();
  }

  async tables(): Promise<TableInfo[]> {
    this.ensureConnected();

    try {
      const response = await this.client!.spreadsheets.get({
        spreadsheetId: this.options.spreadsheetId,
        fields: 'sheets.properties',
      });

      const sheets = response.data.sheets ?? [];
      return sheets.map((sheet) => ({
        name: sheet.properties?.title ?? '',
        schema: undefined,
        rowCount: sheet.properties?.gridProperties?.rowCount,
      }));
    } catch (err) {
      wrapError(err, 'Failed to list sheets');
    }
  }

  /**
   * Read raw header row from a sheet.
   * Returns array of header strings (empty cells use column letter).
   */
  private async readHeaders(sheetName: string): Promise<string[]> {
    const escapedName = escapeSheetName(sheetName);
    const range = `${escapedName}!${this.headerRow}:${this.headerRow}`;

    try {
      const response = await this.client!.spreadsheets.values.get({
        spreadsheetId: this.options.spreadsheetId,
        range,
        valueRenderOption: 'FORMATTED_VALUE',
      });

      const row = response.data.values?.[0] ?? [];
      const headers = row.map((val, i) => {
        const str = val != null ? String(val).trim() : '';
        return str || columnIndexToLetter(i);
      });

      return deduplicateHeaders(headers);
    } catch (err) {
      wrapError(err, `Failed to read headers from sheet "${sheetName}"`);
    }
  }

  /**
   * Infer schema for a sheet by sampling effectiveFormat of first N data rows.
   * Results are cached in schemaCache.
   */
  private async inferSchema(sheetName: string): Promise<InternalColumnInfo[]> {
    const cached = this.schemaCache.get(sheetName);
    if (cached) return cached;

    this.ensureConnected();

    // Step 1: Get headers
    let headers: string[];
    if (this.headerRow === 0) {
      // No header row - determine column count from sample data
      // We'll set headers after reading the data
      headers = [];
    } else {
      headers = await this.readHeaders(sheetName);
    }

    // Step 2: Get effectiveFormat for first SCHEMA_SAMPLE_ROWS data rows
    // dataStartRow is the 0-based row index used to compute the 1-based A1 range below.
    // When headerRow=0 (no header), data starts at sheet row 1, so dataStartRow=0 -> range starts at 0+1=1.
    // When headerRow=N, data starts at sheet row N+1, so dataStartRow=N -> range starts at N+1.
    const dataStartRow = this.headerRow === 0 ? 0 : this.headerRow;
    const escapedName = escapeSheetName(sheetName);

    try {
      const response = await this.client!.spreadsheets.get({
        spreadsheetId: this.options.spreadsheetId,
        ranges: [`${escapedName}!${dataStartRow + 1}:${dataStartRow + SCHEMA_SAMPLE_ROWS}`],
        fields: 'sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat.type)',
      });

      const sheetData = response.data.sheets?.[0]?.data?.[0];
      const rowsData = sheetData?.rowData ?? [];

      // Determine column count
      let columnCount = headers.length;
      if (this.headerRow === 0) {
        // Find max column count from data
        for (const row of rowsData) {
          const vals = row.values ?? [];
          if (vals.length > columnCount) {
            columnCount = vals.length;
          }
        }
        headers = Array.from({ length: columnCount }, (_, i) => columnIndexToLetter(i));
      }

      if (columnCount === 0) {
        this.schemaCache.set(sheetName, []);
        return [];
      }

      // Step 3: Count type frequency per column
      const typeCounts: Array<Map<string, number>> = Array.from(
        { length: columnCount },
        () => new Map()
      );
      const hasData: boolean[] = new Array(columnCount).fill(false);

      for (const row of rowsData) {
        const cells = row.values ?? [];
        for (let col = 0; col < columnCount; col++) {
          const cell = cells[col];
          if (!cell?.effectiveValue) continue;

          hasData[col] = true;

          let type: string;
          if (cell.effectiveValue.boolValue !== undefined) {
            type = 'BOOLEAN';
          } else if (cell.effectiveFormat?.numberFormat?.type) {
            type = inferColumnType(cell.effectiveFormat.numberFormat.type);
          } else if (cell.effectiveValue.numberValue !== undefined) {
            type = 'NUMBER';
          } else {
            type = 'STRING';
          }

          const count = typeCounts[col]!.get(type) ?? 0;
          typeCounts[col]!.set(type, count + 1);
        }
      }

      // Step 4: Build schema - skip columns with no data (empty columns)
      // Each column records its originalIndex for correct mapping in parseRows/insert/update
      const columns: InternalColumnInfo[] = [];
      for (let col = 0; col < columnCount; col++) {
        if (!hasData[col]) continue; // Skip empty columns

        const counts = typeCounts[col]!;
        let bestType = 'STRING';
        let bestCount = 0;
        for (const [type, count] of counts) {
          if (count > bestCount) {
            bestType = type;
            bestCount = count;
          }
        }

        columns.push({
          name: headers[col]!,
          type: bestType,
          nullable: true, // Sheets has no NOT NULL constraint
          originalIndex: col,
        });
      }

      this.schemaCache.set(sheetName, columns);
      return columns;
    } catch (err) {
      wrapError(err, `Failed to infer schema for sheet "${sheetName}"`);
    }
  }

  /**
   * Read all data rows from a sheet, with type conversion based on schema.
   * Skips empty rows. Returns parsed rows and a mapping from data row index
   * to raw (0-based) row index in the sheet data area, so callers can compute
   * the actual sheet row number without a second API call.
   */
  private async readAllRows(sheetName: string): Promise<{ rows: Row[]; rawRowIndices: number[] }> {
    this.ensureConnected();

    const schema = await this.inferSchema(sheetName);
    if (schema.length === 0) return { rows: [], rawRowIndices: [] };

    const escapedName = escapeSheetName(sheetName);
    const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
    const range = `${escapedName}!${dataStartRow}:${MAX_SHEET_ROW}`;

    try {
      const response = await this.client!.spreadsheets.values.get({
        spreadsheetId: this.options.spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      const rawRows = response.data.values ?? [];

      if (rawRows.length > LARGE_DATASET_WARNING_THRESHOLD) {
        console.warn(
          `[venomous] Sheet "${sheetName}" contains ${rawRows.length} rows. ` +
            'Client-side filtering on large datasets may cause performance issues.'
        );
      }

      // Build parsed rows and track original raw row indices (for empty-row skipping)
      const rows: Row[] = [];
      const rawRowIndices: number[] = [];

      for (let i = 0; i < rawRows.length; i++) {
        const rawRow = rawRows[i]!;
        const hasValue = rawRow.some((cell) => cell !== null && cell !== undefined && cell !== '');
        if (!hasValue) continue;

        const row: Row = {};
        for (const col of schema) {
          const rawValue = rawRow[col.originalIndex];
          if (rawValue === null || rawValue === undefined || rawValue === '') {
            row[col.name] = null;
            continue;
          }
          row[col.name] = this.convertValue(rawValue, col.type);
        }
        rows.push(row);
        rawRowIndices.push(i);
      }

      return { rows, rawRowIndices };
    } catch (err) {
      wrapError(err, `Failed to read data from sheet "${sheetName}"`);
    }
  }

  /**
   * Parse raw value arrays into Row objects, applying type conversion.
   * Skips empty rows (all cells null/empty).
   */
  private parseRows(rawRows: unknown[][], schema: InternalColumnInfo[]): Row[] {
    const result: Row[] = [];

    for (const rawRow of rawRows) {
      // Skip empty rows
      const hasValue = rawRow.some((cell) => cell !== null && cell !== undefined && cell !== '');
      if (!hasValue) continue;

      const row: Row = {};
      for (const col of schema) {
        const rawValue = rawRow[col.originalIndex];

        if (rawValue === null || rawValue === undefined || rawValue === '') {
          row[col.name] = null;
          continue;
        }

        row[col.name] = this.convertValue(rawValue, col.type);
      }
      result.push(row);
    }

    return result;
  }

  /**
   * Convert a raw cell value to the appropriate JS type based on column type.
   */
  private convertValue(value: unknown, type: string): unknown {
    if (value === null || value === undefined || value === '') return null;

    switch (type) {
      case 'NUMBER':
        return typeof value === 'number' ? value : Number(value);
      case 'BOOLEAN':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        return Boolean(value);
      case 'DATE':
        if (typeof value === 'number') return serialToDate(value);
        return String(value);
      case 'TIME':
        if (typeof value === 'number') return serialToTime(value);
        return String(value);
      case 'DATETIME':
        if (typeof value === 'number') return serialToDateTime(value);
        return String(value);
      case 'STRING':
      default:
        return String(value);
    }
  }

  async peek(table: string, options?: PeekOptions): Promise<PeekResult> {
    this.ensureConnected();

    let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
    if (rows < 1) rows = 1;
    if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;

    const schema = await this.inferSchema(table);

    if (schema.length === 0) {
      // Empty sheet or no data
      // Check if there are at least headers
      if (this.headerRow > 0) {
        try {
          const headers = await this.readHeaders(table);
          if (headers.length > 0) {
            // Has headers but no data
            const columns: ColumnInfo[] = headers.map((h) => ({
              name: h,
              type: 'STRING',
              nullable: true,
            }));
            return { data: [], columns, totalRows: 0 };
          }
        } catch {
          // Fall through to completely empty result
        }
      }
      return { data: [], columns: undefined, totalRows: 0 };
    }

    const escapedName = escapeSheetName(table);
    const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
    // Read more rows than requested to account for empty rows that will be skipped
    const fetchRows = rows * 2 + 10;
    const range = `${escapedName}!${dataStartRow}:${dataStartRow + fetchRows - 1}`;

    try {
      const response = await this.client!.spreadsheets.values.get({
        spreadsheetId: this.options.spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      const rawRows = response.data.values ?? [];
      const allParsed = this.parseRows(rawRows, schema);
      const data = allParsed.slice(0, rows);

      // Use gridProperties.rowCount as an approximate totalRows
      // (includes empty rows; exact count would require a full-table read, defeating peek's purpose)
      let totalRows: number | undefined;
      try {
        const metaResponse = await this.client!.spreadsheets.get({
          spreadsheetId: this.options.spreadsheetId,
          fields: 'sheets.properties',
        });
        const sheets = metaResponse.data.sheets ?? [];
        const targetSheet = sheets.find((s) => s.properties?.title === table);
        const gridRowCount = targetSheet?.properties?.gridProperties?.rowCount;
        if (gridRowCount != null) {
          // Subtract header rows to approximate data row count
          const headerRows = this.headerRow === 0 ? 0 : this.headerRow;
          totalRows = Math.max(0, gridRowCount - headerRows);
        }
      } catch {
        // If metadata fetch fails, leave totalRows undefined
      }

      return {
        data,
        columns: toPublicSchema(schema),
        totalRows,
      };
    } catch (err) {
      wrapError(err, `Failed to peek sheet "${table}"`);
    }
  }

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
  async find(table: string, options?: FindOptions): Promise<PageResult<Row>> {
    this.ensureConnected();

    const schema = await this.inferSchema(table);

    // Validate orderBy column names
    if (options?.orderBy) {
      const columnNames = new Set(schema.map((c) => c.name));
      for (const clause of options.orderBy) {
        if (!columnNames.has(clause.field)) {
          throw new QueryError(`Unknown column in ORDER BY: "${clause.field}"`, {
            code: 'VENOMOUS_UNKNOWN_COLUMN',
            connector: CONNECTOR_NAME,
          });
        }
      }
    }

    // Read all data
    const { rows: allRows } = await this.readAllRows(table);

    // Apply where filter
    const filtered = applyWhere(allRows, options?.where);

    // Apply orderBy
    const sorted = applyOrderBy(filtered, options?.orderBy);

    // Pagination
    const pageSize = options?.page?.size
      ? validatePageSize(options.page.size).value
      : DEFAULT_PAGE_SIZE;

    let offset = 0;
    if (options?.page?.cursor) {
      const state = decodeCursor(options.page.cursor);
      if (typeof state['offset'] !== 'number') {
        throw new QueryError('Invalid cursor: missing offset', {
          code: 'VENOMOUS_INVALID_CURSOR',
          connector: CONNECTOR_NAME,
        });
      }
      offset = state['offset'] as number;
    }

    const pageData = sorted.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < sorted.length;
    const nextCursor = hasMore ? encodeCursor({ offset: offset + pageSize }) : undefined;

    return {
      data: pageData,
      nextCursor,
      hasMore,
      total: sorted.length,
    };
  }

  /**
   * Google Sheets does not support SQL queries.
   * Use `find()` for filtered queries.
   *
   * @throws {QueryError} Always throws with code `VENOMOUS_NOT_SUPPORTED`.
   */
  sql(_query: string, _params?: unknown[]): AsyncIterable<Row> {
    throw new QueryError(
      'Google Sheets does not support SQL queries. Use find() for filtered queries, or use Google Visualization API Query Language directly via the Sheets API.',
      { code: 'VENOMOUS_NOT_SUPPORTED', connector: CONNECTOR_NAME }
    );
  }

  /**
   * Append rows to a sheet using `spreadsheets.values.append`.
   *
   * @param table - Sheet name.
   * @param rows - Array of row objects to insert.
   * @returns Insert result with count.
   * @throws {PermissionError} When write access is denied.
   */
  async insert(table: string, rows: Row[]): Promise<InsertResult> {
    this.ensureConnected();

    if (rows.length === 0) {
      return { insertedCount: 0 };
    }

    const schema = await this.inferSchema(table);
    const escapedName = escapeSheetName(table);

    // Convert Row objects to value arrays, positioned by original column index.
    // Empty columns (skipped in schema) are filled with empty strings to maintain
    // correct column alignment in the sheet.
    const maxOriginalIndex =
      schema.length > 0 ? Math.max(...schema.map((c) => c.originalIndex)) : -1;
    const values = rows.map((row) => {
      const arr: unknown[] = new Array(maxOriginalIndex + 1).fill('');
      for (const col of schema) {
        const val = row[col.name];
        arr[col.originalIndex] = val === null || val === undefined ? '' : val;
      }
      return arr;
    });

    try {
      const response = await this.client!.spreadsheets.values.append({
        spreadsheetId: this.options.spreadsheetId,
        range: escapedName,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });

      const updatedRows = (response.data as AppendData).updates?.updatedRows ?? rows.length;
      return { insertedCount: updatedRows };
    } catch (err) {
      wrapError(err, `Failed to insert into sheet "${table}"`);
    }
  }

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
  async update(table: string, options: UpdateOptions): Promise<UpdateResult> {
    this.ensureConnected();

    // Reject empty where
    if (!options.where || options.where.length === 0) {
      throw new QueryError(
        'WHERE clause is required for update. Provide at least one condition to prevent full-table update.',
        { code: 'VENOMOUS_EMPTY_WHERE', connector: CONNECTOR_NAME }
      );
    }

    const schema = await this.inferSchema(table);

    // Read all data with row index mapping (single API call)
    const { rows: allRows, rawRowIndices } = await this.readAllRows(table);
    const matchingIndices: number[] = [];

    for (let i = 0; i < allRows.length; i++) {
      if (matchRow(allRows[i]!, options.where)) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 0) {
      return { updatedCount: 0 };
    }

    const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
    const escapedName = escapeSheetName(table);

    // Build update ranges using rawRowIndices from readAllRows (no second API call needed)
    // Values are positioned by original column index to handle skipped empty columns
    const maxOriginalIndex =
      schema.length > 0 ? Math.max(...schema.map((c) => c.originalIndex)) : -1;

    const updateData: Array<{ range: string; values: unknown[][] }> = [];
    for (const dataIdx of matchingIndices) {
      const rawIdx = rawRowIndices[dataIdx];
      if (rawIdx === undefined) continue;

      const sheetRow = dataStartRow + rawIdx;

      // Build the updated row values, positioned by original column index
      const updatedValues: unknown[] = new Array(maxOriginalIndex + 1).fill('');
      for (const col of schema) {
        if (col.name in options.set) {
          const val = options.set[col.name];
          updatedValues[col.originalIndex] = val === null || val === undefined ? '' : val;
        } else {
          const existingRow = allRows[dataIdx]!;
          const val = existingRow[col.name];
          updatedValues[col.originalIndex] = val === null || val === undefined ? '' : val;
        }
      }

      updateData.push({
        range: `${escapedName}!A${sheetRow}`,
        values: [updatedValues],
      });
    }

    try {
      await this.client!.spreadsheets.values.batchUpdate({
        spreadsheetId: this.options.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData,
        },
      });

      return { updatedCount: matchingIndices.length };
    } catch (err) {
      wrapError(err, `Failed to update sheet "${table}"`);
    }
  }

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
  async remove(table: string, options: WhereOptions): Promise<DeleteResult> {
    this.ensureConnected();

    // Reject empty where
    if (!options.where || options.where.length === 0) {
      throw new QueryError(
        'WHERE clause is required for delete. Provide at least one condition to prevent full-table delete.',
        { code: 'VENOMOUS_EMPTY_WHERE', connector: CONNECTOR_NAME }
      );
    }

    // Read all data with row index mapping (single API call)
    const { rows: allRows, rawRowIndices } = await this.readAllRows(table);
    const matchingIndices: number[] = [];

    for (let i = 0; i < allRows.length; i++) {
      if (matchRow(allRows[i]!, options.where)) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 0) {
      return { deletedCount: 0 };
    }

    // Get the sheet ID (needed for deleteDimension)
    let sheetId: number;
    try {
      const response = await this.client!.spreadsheets.get({
        spreadsheetId: this.options.spreadsheetId,
        fields: 'sheets.properties',
      });
      const sheets = response.data.sheets ?? [];
      const targetSheet = sheets.find((s) => s.properties?.title === table);
      if (!targetSheet || targetSheet.properties?.sheetId == null) {
        throw new NotFoundError(`Sheet "${table}" not found`, {
          connector: CONNECTOR_NAME,
        });
      }
      sheetId = targetSheet.properties.sheetId;
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      wrapError(err, `Failed to get sheet info for "${table}"`);
    }

    const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;

    // Convert to sheet row indices (0-based for deleteDimension)
    const sheetRowIndices = matchingIndices
      .map((dataIdx) => {
        const rawIdx = rawRowIndices[dataIdx];
        if (rawIdx === undefined) return -1;
        return dataStartRow - 1 + rawIdx; // 0-based sheet row
      })
      .filter((idx) => idx >= 0);

    // Sort in reverse order to avoid row number shifts
    sheetRowIndices.sort((a, b) => b - a);

    // Build batch delete requests
    const requests = sheetRowIndices.map((rowIdx) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIdx,
          endIndex: rowIdx + 1,
        },
      },
    }));

    try {
      await this.client!.spreadsheets.batchUpdate({
        spreadsheetId: this.options.spreadsheetId,
        requestBody: { requests },
      });

      return { deletedCount: matchingIndices.length };
    } catch (err) {
      wrapError(err, `Failed to delete from sheet "${table}"`);
    }
  }
}
