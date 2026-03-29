import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, validatePageSize } from "../core/index.js";

//#region src/google-sheets/auth.ts
/** Google Sheets API scope (full read/write access). */
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/**
* Resolve a SheetsAuth config into a GoogleAuth configuration object.
*
* The returned object is passed to `new google.auth.GoogleAuth(config)`.
* The scope is always set to `https://www.googleapis.com/auth/spreadsheets`
* (full read/write access), consistent with other Google connectors that
* do not distinguish read-only vs read-write scopes.
*
* @param auth - Auth configuration (defaults to auto/ADC if undefined).
* @returns Configuration object for GoogleAuth constructor.
*
* @example
* ```typescript
* const config = resolveAuth({ type: 'auto' });
* // { scopes: ['https://www.googleapis.com/auth/spreadsheets'] }
*
* const config2 = resolveAuth({ credentials: {...} });
* // { scopes: [...], credentials: {...} }
* ```
*/
function resolveAuth(auth) {
	const base = { scopes: [SHEETS_SCOPE] };
	if (!auth || auth.type === "auto") return base;
	if (!auth.type || auth.type === "credentials") return {
		...base,
		credentials: auth.credentials
	};
	throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}

//#endregion
//#region src/google-sheets/connector.ts
const CONNECTOR_NAME = "google-sheets";
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1e3;
const DEFAULT_PAGE_SIZE = 50;
const SCHEMA_SAMPLE_ROWS = 100;
const LARGE_DATASET_WARNING_THRESHOLD = 5e4;
/** Sentinel row number for reading "all remaining rows" in A1 notation ranges. */
const MAX_SHEET_ROW = 999999999;
/**
* Sheets epoch: 1899-12-30T00:00:00Z.
* Google Sheets uses a serial number system based on this date.
*/
const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 864e5;
/**
* Map Google Sheets API errors to appropriate VenomousError subclasses.
*/
function wrapError(err, defaultMessage) {
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const errCode = err.code;
		if (errCode === 401) throw new AuthenticationError(`Sheets authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errCode === 403) throw new PermissionError(`Sheets permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errCode === 404) throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errCode === 429) {
			const retryAfter = err.retryAfter;
			const retryInfo = retryAfter != null ? ` Retry after: ${retryAfter}` : "";
			throw new QueryError(`Sheets API rate limit exceeded: ${message}${retryInfo}`, {
				code: "VENOMOUS_RATE_LIMITED",
				cause: err,
				connector: CONNECTOR_NAME
			});
		}
		if (message.includes("PERMISSION_DENIED")) throw new PermissionError(`Sheets permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("Could not load the default credentials") || message.includes("invalid_grant") || message.includes("UNAUTHENTICATED") || message.includes("credentials are required") || message.includes("credentials are not valid")) throw new AuthenticationError(`Sheets authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND") || message.includes("network error") || message.includes("Network Error")) throw new ConnectionError(`Sheets connection failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`Sheets query failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}
/**
* Escape a sheet name for use in A1 notation ranges.
* If the name contains spaces or special characters, wrap in single quotes.
* Single quotes within the name are escaped by doubling.
*/
function escapeSheetName(name) {
	const escaped = name.replace(/'/g, "''");
	return `'${escaped}'`;
}
/**
* Generate an Excel-style column letter from a 0-based column index.
* 0 -> A, 1 -> B, ..., 25 -> Z, 26 -> AA, 27 -> AB, ...
*/
function columnIndexToLetter(index) {
	let result = "";
	let remaining = index;
	do {
		result = String.fromCharCode(65 + remaining % 26) + result;
		remaining = Math.floor(remaining / 26) - 1;
	} while (remaining >= 0);
	return result;
}
/**
* De-duplicate header names by appending _2, _3, etc. for duplicates.
*/
function deduplicateHeaders(headers) {
	const counts = new Map();
	const result = [];
	for (const header of headers) {
		const count = counts.get(header) ?? 0;
		counts.set(header, count + 1);
		if (count === 0) result.push(header);
		else result.push(`${header}_${count + 1}`);
	}
	return result;
}
/**
* Convert a Sheets serial number to an ISO date string (YYYY-MM-DD).
*/
function serialToDate(serial) {
	const ms = SHEETS_EPOCH + Math.floor(serial) * MS_PER_DAY;
	const d = new Date(ms);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
/**
* Convert a Sheets serial number (fractional part) to an ISO time string (HH:mm:ss).
*/
function serialToTime(serial) {
	const fraction = serial - Math.floor(serial);
	const totalSeconds = Math.round(fraction * 86400);
	const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
	const minutes = String(Math.floor(totalSeconds % 3600 / 60)).padStart(2, "0");
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}
/**
* Convert a Sheets serial number to an ISO datetime string (YYYY-MM-DDTHH:mm:ss).
*/
function serialToDateTime(serial) {
	return `${serialToDate(serial)}T${serialToTime(serial)}`;
}
/**
* Check if a single row matches a WHERE condition.
* Shared by find(), update(), and remove().
*/
function matchCondition(value, condition) {
	switch (condition.operator) {
		case "eq":
			if (condition.value === null) return value === null || value === void 0;
			return value === condition.value;
		case "ne":
			if (condition.value === null) return value !== null && value !== void 0;
			return value !== condition.value;
		case "gt":
			if (value === null || value === void 0) return false;
			return value > condition.value;
		case "lt":
			if (value === null || value === void 0) return false;
			return value < condition.value;
		case "gte":
			if (value === null || value === void 0) return false;
			return value >= condition.value;
		case "lte":
			if (value === null || value === void 0) return false;
			return value <= condition.value;
		case "in": {
			const arr = condition.value;
			return arr.includes(value);
		}
		case "like": {
			if (value === null || value === void 0) return false;
			const pattern = condition.value;
			const PERCENT_PH = "\0PCT\0";
			const UNDERSCORE_PH = "\0USC\0";
			const withPlaceholders = pattern.replace(/%/g, PERCENT_PH).replace(/_/g, UNDERSCORE_PH);
			const escaped = withPlaceholders.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regexStr = escaped.replace(new RegExp(PERCENT_PH.replace(/\x00/g, "\\x00"), "g"), ".*").replace(new RegExp(UNDERSCORE_PH.replace(/\x00/g, "\\x00"), "g"), ".");
			const regex = new RegExp(`^${regexStr}$`, "i");
			return regex.test(String(value));
		}
		default: {
			const _exhaustive = condition.operator;
			throw new QueryError(`Unsupported operator: "${String(_exhaustive)}"`, {
				code: "VENOMOUS_UNSUPPORTED_OPERATOR",
				connector: CONNECTOR_NAME
			});
		}
	}
}
/**
* Check if a row matches all conditions in a WHERE clause (AND logic).
*/
function matchRow(row, where) {
	return where.every((condition) => matchCondition(row[condition.field], condition));
}
/**
* Apply a WHERE clause to filter rows. Shared by find(), update(), and remove().
*/
function applyWhere(rows, where) {
	if (!where || where.length === 0) return rows;
	return rows.filter((row) => matchRow(row, where));
}
/**
* Apply ORDER BY clauses to sort rows.
*/
function applyOrderBy(rows, orderBy) {
	if (!orderBy || orderBy.length === 0) return rows;
	return [...rows].sort((a, b) => {
		for (const clause of orderBy) {
			const aVal = a[clause.field];
			const bVal = b[clause.field];
			if (aVal === null || aVal === void 0) {
				if (bVal === null || bVal === void 0) continue;
				return clause.direction === "asc" ? 1 : -1;
			}
			if (bVal === null || bVal === void 0) return clause.direction === "asc" ? -1 : 1;
			let cmp;
			if (typeof aVal === "number" && typeof bVal === "number") cmp = aVal - bVal;
			else cmp = String(aVal).localeCompare(String(bVal));
			if (cmp !== 0) return clause.direction === "desc" ? -cmp : cmp;
		}
		return 0;
	});
}
/**
* Infer a ColumnInfo type string from Sheets effectiveFormat numberFormat type.
*/
function inferColumnType(formatType) {
	switch (formatType) {
		case "NUMBER":
		case "CURRENCY":
		case "PERCENT": return "NUMBER";
		case "DATE": return "DATE";
		case "TIME": return "TIME";
		case "DATE_TIME": return "DATETIME";
		case "TEXT": return "STRING";
		default: return "STRING";
	}
}
/** Strip internal fields (originalIndex) from schema before returning to public API. */
function toPublicSchema(schema) {
	return schema.map(({ name, type, nullable }) => ({
		name,
		type,
		nullable
	}));
}
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
var SheetsConnector = class {
	options;
	headerRow;
	client = null;
	connected = false;
	/** Cached schema per sheet name (includes original column indices). */
	schemaCache = new Map();
	constructor(options) {
		this.options = options;
		this.headerRow = options.headerRow ?? 1;
	}
	/**
	* Ensure the connector is connected.
	* @throws {ConnectionError} if not connected.
	*/
	ensureConnected() {
		if (!this.connected || !this.client) throw new ConnectionError("Not connected. Call connect() first.", {
			code: "VENOMOUS_NOT_CONNECTED",
			connector: CONNECTOR_NAME
		});
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
	async connect(auth) {
		if (this.connected) await this.disconnect();
		let google;
		try {
			google = await import("googleapis");
		} catch (err) {
			if (err instanceof Error && "code" in err && (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND")) throw new ConnectionError("googleapis is required for the Sheets connector. Install it with: npm install googleapis", {
				code: "VENOMOUS_MISSING_DEPENDENCY",
				connector: CONNECTOR_NAME
			});
			throw err;
		}
		const authConfig = resolveAuth(auth);
		const googleAuth = new google.google.auth.GoogleAuth(authConfig);
		const sheets = google.google.sheets({
			version: "v4",
			auth: googleAuth
		});
		this.client = sheets;
		try {
			await this.client.spreadsheets.get({
				spreadsheetId: this.options.spreadsheetId,
				fields: "spreadsheetId,properties.title"
			});
		} catch (err) {
			this.client = null;
			wrapError(err, `Failed to connect to spreadsheet "${this.options.spreadsheetId}"`);
		}
		this.connected = true;
	}
	async disconnect() {
		this.client = null;
		this.connected = false;
		this.schemaCache.clear();
	}
	async tables() {
		this.ensureConnected();
		try {
			const response = await this.client.spreadsheets.get({
				spreadsheetId: this.options.spreadsheetId,
				fields: "sheets.properties"
			});
			const sheets = response.data.sheets ?? [];
			return sheets.map((sheet) => ({
				name: sheet.properties?.title ?? "",
				schema: void 0,
				rowCount: sheet.properties?.gridProperties?.rowCount
			}));
		} catch (err) {
			wrapError(err, "Failed to list sheets");
		}
	}
	/**
	* Read raw header row from a sheet.
	* Returns array of header strings (empty cells use column letter).
	*/
	async readHeaders(sheetName) {
		const escapedName = escapeSheetName(sheetName);
		const range = `${escapedName}!${this.headerRow}:${this.headerRow}`;
		try {
			const response = await this.client.spreadsheets.values.get({
				spreadsheetId: this.options.spreadsheetId,
				range,
				valueRenderOption: "FORMATTED_VALUE"
			});
			const row = response.data.values?.[0] ?? [];
			const headers = row.map((val, i) => {
				const str = val != null ? String(val).trim() : "";
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
	async inferSchema(sheetName) {
		const cached = this.schemaCache.get(sheetName);
		if (cached) return cached;
		this.ensureConnected();
		let headers;
		if (this.headerRow === 0) headers = [];
		else headers = await this.readHeaders(sheetName);
		const dataStartRow = this.headerRow === 0 ? 0 : this.headerRow;
		const escapedName = escapeSheetName(sheetName);
		try {
			const response = await this.client.spreadsheets.get({
				spreadsheetId: this.options.spreadsheetId,
				ranges: [`${escapedName}!${dataStartRow + 1}:${dataStartRow + SCHEMA_SAMPLE_ROWS}`],
				fields: "sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat.type)"
			});
			const sheetData = response.data.sheets?.[0]?.data?.[0];
			const rowsData = sheetData?.rowData ?? [];
			let columnCount = headers.length;
			if (this.headerRow === 0) {
				for (const row of rowsData) {
					const vals = row.values ?? [];
					if (vals.length > columnCount) columnCount = vals.length;
				}
				headers = Array.from({ length: columnCount }, (_, i) => columnIndexToLetter(i));
			}
			if (columnCount === 0) {
				this.schemaCache.set(sheetName, []);
				return [];
			}
			const typeCounts = Array.from({ length: columnCount }, () => new Map());
			const hasData = new Array(columnCount).fill(false);
			for (const row of rowsData) {
				const cells = row.values ?? [];
				for (let col = 0; col < columnCount; col++) {
					const cell = cells[col];
					if (!cell?.effectiveValue) continue;
					hasData[col] = true;
					let type;
					if (cell.effectiveValue.boolValue !== void 0) type = "BOOLEAN";
					else if (cell.effectiveFormat?.numberFormat?.type) type = inferColumnType(cell.effectiveFormat.numberFormat.type);
					else if (cell.effectiveValue.numberValue !== void 0) type = "NUMBER";
					else type = "STRING";
					const count = typeCounts[col].get(type) ?? 0;
					typeCounts[col].set(type, count + 1);
				}
			}
			const columns = [];
			for (let col = 0; col < columnCount; col++) {
				if (!hasData[col]) continue;
				const counts = typeCounts[col];
				let bestType = "STRING";
				let bestCount = 0;
				for (const [type, count] of counts) if (count > bestCount) {
					bestType = type;
					bestCount = count;
				}
				columns.push({
					name: headers[col],
					type: bestType,
					nullable: true,
					originalIndex: col
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
	async readAllRows(sheetName) {
		this.ensureConnected();
		const schema = await this.inferSchema(sheetName);
		if (schema.length === 0) return {
			rows: [],
			rawRowIndices: []
		};
		const escapedName = escapeSheetName(sheetName);
		const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
		const range = `${escapedName}!${dataStartRow}:${MAX_SHEET_ROW}`;
		try {
			const response = await this.client.spreadsheets.values.get({
				spreadsheetId: this.options.spreadsheetId,
				range,
				valueRenderOption: "UNFORMATTED_VALUE"
			});
			const rawRows = response.data.values ?? [];
			if (rawRows.length > LARGE_DATASET_WARNING_THRESHOLD) console.warn(`[venomous] Sheet "${sheetName}" contains ${rawRows.length} rows. Client-side filtering on large datasets may cause performance issues.`);
			const rows = [];
			const rawRowIndices = [];
			for (let i = 0; i < rawRows.length; i++) {
				const rawRow = rawRows[i];
				const hasValue = rawRow.some((cell) => cell !== null && cell !== void 0 && cell !== "");
				if (!hasValue) continue;
				const row = {};
				for (const col of schema) {
					const rawValue = rawRow[col.originalIndex];
					if (rawValue === null || rawValue === void 0 || rawValue === "") {
						row[col.name] = null;
						continue;
					}
					row[col.name] = this.convertValue(rawValue, col.type);
				}
				rows.push(row);
				rawRowIndices.push(i);
			}
			return {
				rows,
				rawRowIndices
			};
		} catch (err) {
			wrapError(err, `Failed to read data from sheet "${sheetName}"`);
		}
	}
	/**
	* Parse raw value arrays into Row objects, applying type conversion.
	* Skips empty rows (all cells null/empty).
	*/
	parseRows(rawRows, schema) {
		const result = [];
		for (const rawRow of rawRows) {
			const hasValue = rawRow.some((cell) => cell !== null && cell !== void 0 && cell !== "");
			if (!hasValue) continue;
			const row = {};
			for (const col of schema) {
				const rawValue = rawRow[col.originalIndex];
				if (rawValue === null || rawValue === void 0 || rawValue === "") {
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
	convertValue(value, type) {
		if (value === null || value === void 0 || value === "") return null;
		switch (type) {
			case "NUMBER": return typeof value === "number" ? value : Number(value);
			case "BOOLEAN":
				if (typeof value === "boolean") return value;
				if (typeof value === "string") return value.toLowerCase() === "true";
				return Boolean(value);
			case "DATE":
				if (typeof value === "number") return serialToDate(value);
				return String(value);
			case "TIME":
				if (typeof value === "number") return serialToTime(value);
				return String(value);
			case "DATETIME":
				if (typeof value === "number") return serialToDateTime(value);
				return String(value);
			case "STRING":
			default: return String(value);
		}
	}
	async peek(table, options) {
		this.ensureConnected();
		let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		if (rows < 1) rows = 1;
		if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;
		const schema = await this.inferSchema(table);
		if (schema.length === 0) {
			if (this.headerRow > 0) try {
				const headers = await this.readHeaders(table);
				if (headers.length > 0) {
					const columns = headers.map((h) => ({
						name: h,
						type: "STRING",
						nullable: true
					}));
					return {
						data: [],
						columns,
						totalRows: 0
					};
				}
			} catch {}
			return {
				data: [],
				columns: void 0,
				totalRows: 0
			};
		}
		const escapedName = escapeSheetName(table);
		const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
		const fetchRows = rows * 2 + 10;
		const range = `${escapedName}!${dataStartRow}:${dataStartRow + fetchRows - 1}`;
		try {
			const response = await this.client.spreadsheets.values.get({
				spreadsheetId: this.options.spreadsheetId,
				range,
				valueRenderOption: "UNFORMATTED_VALUE"
			});
			const rawRows = response.data.values ?? [];
			const allParsed = this.parseRows(rawRows, schema);
			const data = allParsed.slice(0, rows);
			let totalRows;
			try {
				const metaResponse = await this.client.spreadsheets.get({
					spreadsheetId: this.options.spreadsheetId,
					fields: "sheets.properties"
				});
				const sheets = metaResponse.data.sheets ?? [];
				const targetSheet = sheets.find((s) => s.properties?.title === table);
				const gridRowCount = targetSheet?.properties?.gridProperties?.rowCount;
				if (gridRowCount != null) {
					const headerRows = this.headerRow === 0 ? 0 : this.headerRow;
					totalRows = Math.max(0, gridRowCount - headerRows);
				}
			} catch {}
			return {
				data,
				columns: toPublicSchema(schema),
				totalRows
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
	async find(table, options) {
		this.ensureConnected();
		const schema = await this.inferSchema(table);
		if (options?.orderBy) {
			const columnNames = new Set(schema.map((c) => c.name));
			for (const clause of options.orderBy) if (!columnNames.has(clause.field)) throw new QueryError(`Unknown column in ORDER BY: "${clause.field}"`, {
				code: "VENOMOUS_UNKNOWN_COLUMN",
				connector: CONNECTOR_NAME
			});
		}
		const { rows: allRows } = await this.readAllRows(table);
		const filtered = applyWhere(allRows, options?.where);
		const sorted = applyOrderBy(filtered, options?.orderBy);
		const pageSize = options?.page?.size ? validatePageSize(options.page.size).value : DEFAULT_PAGE_SIZE;
		let offset = 0;
		if (options?.page?.cursor) {
			const state = decodeCursor(options.page.cursor);
			if (typeof state["offset"] !== "number") throw new QueryError("Invalid cursor: missing offset", {
				code: "VENOMOUS_INVALID_CURSOR",
				connector: CONNECTOR_NAME
			});
			offset = state["offset"];
		}
		const pageData = sorted.slice(offset, offset + pageSize);
		const hasMore = offset + pageSize < sorted.length;
		const nextCursor = hasMore ? encodeCursor({ offset: offset + pageSize }) : void 0;
		return {
			data: pageData,
			nextCursor,
			hasMore,
			total: sorted.length
		};
	}
	/**
	* Google Sheets does not support SQL queries.
	* Use `find()` for filtered queries.
	*
	* @throws {QueryError} Always throws with code `VENOMOUS_NOT_SUPPORTED`.
	*/
	sql(_query, _params) {
		throw new QueryError("Google Sheets does not support SQL queries. Use find() for filtered queries, or use Google Visualization API Query Language directly via the Sheets API.", {
			code: "VENOMOUS_NOT_SUPPORTED",
			connector: CONNECTOR_NAME
		});
	}
	/**
	* Append rows to a sheet using `spreadsheets.values.append`.
	*
	* @param table - Sheet name.
	* @param rows - Array of row objects to insert.
	* @returns Insert result with count.
	* @throws {PermissionError} When write access is denied.
	*/
	async insert(table, rows) {
		this.ensureConnected();
		if (rows.length === 0) return { insertedCount: 0 };
		const schema = await this.inferSchema(table);
		const escapedName = escapeSheetName(table);
		const maxOriginalIndex = schema.length > 0 ? Math.max(...schema.map((c) => c.originalIndex)) : -1;
		const values = rows.map((row) => {
			const arr = new Array(maxOriginalIndex + 1).fill("");
			for (const col of schema) {
				const val = row[col.name];
				arr[col.originalIndex] = val === null || val === void 0 ? "" : val;
			}
			return arr;
		});
		try {
			const response = await this.client.spreadsheets.values.append({
				spreadsheetId: this.options.spreadsheetId,
				range: escapedName,
				valueInputOption: "USER_ENTERED",
				insertDataOption: "INSERT_ROWS",
				requestBody: { values }
			});
			const updatedRows = response.data.updates?.updatedRows ?? rows.length;
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
	async update(table, options) {
		this.ensureConnected();
		if (!options.where || options.where.length === 0) throw new QueryError("WHERE clause is required for update. Provide at least one condition to prevent full-table update.", {
			code: "VENOMOUS_EMPTY_WHERE",
			connector: CONNECTOR_NAME
		});
		const schema = await this.inferSchema(table);
		const { rows: allRows, rawRowIndices } = await this.readAllRows(table);
		const matchingIndices = [];
		for (let i = 0; i < allRows.length; i++) if (matchRow(allRows[i], options.where)) matchingIndices.push(i);
		if (matchingIndices.length === 0) return { updatedCount: 0 };
		const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
		const escapedName = escapeSheetName(table);
		const maxOriginalIndex = schema.length > 0 ? Math.max(...schema.map((c) => c.originalIndex)) : -1;
		const updateData = [];
		for (const dataIdx of matchingIndices) {
			const rawIdx = rawRowIndices[dataIdx];
			if (rawIdx === void 0) continue;
			const sheetRow = dataStartRow + rawIdx;
			const updatedValues = new Array(maxOriginalIndex + 1).fill("");
			for (const col of schema) if (col.name in options.set) {
				const val = options.set[col.name];
				updatedValues[col.originalIndex] = val === null || val === void 0 ? "" : val;
			} else {
				const existingRow = allRows[dataIdx];
				const val = existingRow[col.name];
				updatedValues[col.originalIndex] = val === null || val === void 0 ? "" : val;
			}
			updateData.push({
				range: `${escapedName}!A${sheetRow}`,
				values: [updatedValues]
			});
		}
		try {
			await this.client.spreadsheets.values.batchUpdate({
				spreadsheetId: this.options.spreadsheetId,
				requestBody: {
					valueInputOption: "USER_ENTERED",
					data: updateData
				}
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
	async remove(table, options) {
		this.ensureConnected();
		if (!options.where || options.where.length === 0) throw new QueryError("WHERE clause is required for delete. Provide at least one condition to prevent full-table delete.", {
			code: "VENOMOUS_EMPTY_WHERE",
			connector: CONNECTOR_NAME
		});
		const { rows: allRows, rawRowIndices } = await this.readAllRows(table);
		const matchingIndices = [];
		for (let i = 0; i < allRows.length; i++) if (matchRow(allRows[i], options.where)) matchingIndices.push(i);
		if (matchingIndices.length === 0) return { deletedCount: 0 };
		let sheetId;
		try {
			const response = await this.client.spreadsheets.get({
				spreadsheetId: this.options.spreadsheetId,
				fields: "sheets.properties"
			});
			const sheets = response.data.sheets ?? [];
			const targetSheet = sheets.find((s) => s.properties?.title === table);
			if (!targetSheet || targetSheet.properties?.sheetId == null) throw new NotFoundError(`Sheet "${table}" not found`, { connector: CONNECTOR_NAME });
			sheetId = targetSheet.properties.sheetId;
		} catch (err) {
			if (err instanceof NotFoundError) throw err;
			wrapError(err, `Failed to get sheet info for "${table}"`);
		}
		const dataStartRow = this.headerRow === 0 ? 1 : this.headerRow + 1;
		const sheetRowIndices = matchingIndices.map((dataIdx) => {
			const rawIdx = rawRowIndices[dataIdx];
			if (rawIdx === void 0) return -1;
			return dataStartRow - 1 + rawIdx;
		}).filter((idx) => idx >= 0);
		sheetRowIndices.sort((a, b) => b - a);
		const requests = sheetRowIndices.map((rowIdx) => ({ deleteDimension: { range: {
			sheetId,
			dimension: "ROWS",
			startIndex: rowIdx,
			endIndex: rowIdx + 1
		} } }));
		try {
			await this.client.spreadsheets.batchUpdate({
				spreadsheetId: this.options.spreadsheetId,
				requestBody: { requests }
			});
			return { deletedCount: matchingIndices.length };
		} catch (err) {
			wrapError(err, `Failed to delete from sheet "${table}"`);
		}
	}
};

//#endregion
//#region src/google-sheets/index.ts
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
function createSheetsConnector(options) {
	return new SheetsConnector(options);
}

//#endregion
export { SheetsConnector, createSheetsConnector };
//# sourceMappingURL=index.js.map