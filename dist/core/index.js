//#region src/core/errors/base.ts
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
var VenomousError = class extends Error {
	/** Machine-readable error code (e.g., `VENOMOUS_AUTH_FAILED`). */
	code;
	/** Connector type that produced this error (e.g., `bigquery`, `aws-s3`). */
	connector;
	constructor(message, options) {
		super(message, { cause: options?.cause });
		this.name = "VenomousError";
		this.code = options?.code ?? "VENOMOUS_ERROR";
		this.connector = options?.connector;
		Object.setPrototypeOf(this, new.target.prototype);
	}
	/**
	* Returns a sanitized JSON representation.
	* Sensitive information (auth credentials, full file paths in cause) is excluded.
	*/
	toJSON() {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			connector: this.connector,
			cause: this.cause instanceof Error ? {
				name: this.cause.name,
				message: this.cause.message
			} : void 0
		};
	}
};

//#endregion
//#region src/core/errors/auth.ts
/**
* Thrown when authentication fails (invalid credentials, expired tokens, etc.).
*/
var AuthenticationError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_AUTH_FAILED",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "AuthenticationError";
	}
};

//#endregion
//#region src/core/errors/connection.ts
/**
* Thrown when a connection to the data source fails (network errors, service unreachable, etc.).
*/
var ConnectionError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_CONNECTION_FAILED",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "ConnectionError";
	}
};

//#endregion
//#region src/core/errors/query.ts
/**
* Thrown when a query fails (syntax error, execution failure, invalid cursor, etc.).
*/
var QueryError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_QUERY_FAILED",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "QueryError";
	}
};

//#endregion
//#region src/core/errors/path.ts
/**
* Thrown when a file path is invalid (traversal attack, absolute path, encoding error, etc.).
*/
var PathError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_PATH_INVALID",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "PathError";
	}
};

//#endregion
//#region src/core/errors/not-found.ts
/**
* Thrown when a requested resource (table, file, bucket) does not exist.
*/
var NotFoundError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_NOT_FOUND",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "NotFoundError";
	}
};

//#endregion
//#region src/core/errors/permission.ts
/**
* Thrown when the caller lacks sufficient permissions (IAM, ACL, etc.).
*/
var PermissionError = class extends VenomousError {
	constructor(message, options) {
		super(message, {
			code: options?.code ?? "VENOMOUS_PERMISSION_DENIED",
			cause: options?.cause,
			connector: options?.connector
		});
		this.name = "PermissionError";
	}
};

//#endregion
//#region src/core/utils/path.ts
const MAX_PATH_LENGTH = 1024;
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
function normalizePath(path) {
	if (path === void 0 || path === null || path.trim() === "") throw new PathError("Path must not be empty", { code: "VENOMOUS_PATH_EMPTY" });
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {}
	decoded = decoded.replace(/\\/g, "/");
	decoded = decoded.normalize("NFC");
	if (containsTraversal(decoded)) throw new PathError("Path traversal detected", { code: "VENOMOUS_PATH_TRAVERSAL" });
	if (/%2e%2e/i.test(decoded)) throw new PathError("Path traversal detected (encoded)", { code: "VENOMOUS_PATH_TRAVERSAL" });
	if (decoded.startsWith("/")) throw new PathError("Absolute paths are not allowed", { code: "VENOMOUS_PATH_ABSOLUTE" });
	const normalized = decoded.replace(/\/+$/g, "");
	if (normalized === ".") return "";
	if (normalized.length > MAX_PATH_LENGTH) throw new PathError(`Path exceeds maximum length of ${MAX_PATH_LENGTH} characters`, { code: "VENOMOUS_PATH_TOO_LONG" });
	return normalized;
}
/**
* Check whether a path is safe without throwing an exception.
*
* @param path - User-provided file path.
* @returns `true` if the path is safe, `false` otherwise.
*/
function isPathSafe(path) {
	try {
		normalizePath(path);
		return true;
	} catch {
		return false;
	}
}
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
function encodeCJK(path) {
	return path.split("/").map((segment) => segment.replace(/[^\x20-\x7E]/g, (char) => encodeURIComponent(char))).join("/");
}
/**
* Detect path traversal patterns in a decoded path string.
* Checks each path segment for exact `..` match.
*/
function containsTraversal(path) {
	const segments = path.split("/");
	for (const segment of segments) if (segment === "..") return true;
	return false;
}

//#endregion
//#region src/core/utils/sanitize.ts
/**
* Default set of sensitive field names that should be redacted from auth objects.
*/
const DEFAULT_SENSITIVE_FIELDS = new Set([
	"secretAccessKey",
	"accessKeyId",
	"credentials",
	"private_key",
	"client_email"
]);
const REDACTED = "[REDACTED]";
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
function redactAuth(auth, additionalFields) {
	if (auth === null || auth === void 0) return auth;
	if (typeof auth !== "object") return auth;
	const sensitiveFields = additionalFields ? new Set([...DEFAULT_SENSITIVE_FIELDS, ...additionalFields]) : DEFAULT_SENSITIVE_FIELDS;
	return redactObject(auth, sensitiveFields, new WeakSet());
}
/**
* Recursively redact sensitive fields from an object.
* Uses a WeakSet to detect and handle circular references.
*/
function redactObject(obj, sensitiveFields, visited) {
	if (visited.has(obj)) return { "[Circular]": true };
	visited.add(obj);
	if (Array.isArray(obj)) return obj.map((item) => typeof item === "object" && item !== null ? redactObject(item, sensitiveFields, visited) : item);
	const result = {};
	for (const [key, value] of Object.entries(obj)) if (sensitiveFields.has(key)) result[key] = REDACTED;
	else if (typeof value === "object" && value !== null) result[key] = redactObject(value, sensitiveFields, visited);
	else result[key] = value;
	return result;
}
/**
* Create a sanitized plain object from an Error, safe for logging/serialization.
* Recursively processes the cause chain.
*
* @param error - Any error object.
* @returns A plain object with sanitized error information.
*
* @example
* ```typescript
* try {
*   await connector.connect(auth);
* } catch (err) {
*   const safe = sanitizeError(err);
*   logger.error('Connection failed', safe);
* }
* ```
*/
const MAX_CAUSE_DEPTH = 10;
function sanitizeError(error) {
	return sanitizeErrorInternal(error, MAX_CAUSE_DEPTH);
}
/**
* Internal recursive implementation with depth limit to prevent
* stack overflow from circular cause chains.
*/
function sanitizeErrorInternal(error, remainingDepth) {
	if (!(error instanceof Error)) return { message: String(error) };
	const result = {
		name: error.name,
		message: error.message
	};
	if ("code" in error && typeof error.code === "string") result["code"] = error.code;
	if ("connector" in error && typeof error.connector === "string") result["connector"] = error.connector;
	if (error.cause instanceof Error) if (remainingDepth > 0) result["cause"] = sanitizeErrorInternal(error.cause, remainingDepth - 1);
	else result["cause"] = { message: "[Truncated: cause chain too deep]" };
	return result;
}

//#endregion
//#region src/core/utils/pagination.ts
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 1e3;
const DEFAULT_PAGE_SIZE = 50;
const CURSOR_VERSION = 1;
const CURSOR_LENGTH_WARNING_THRESHOLD = 2048;
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
function validatePageSize(size) {
	if (!Number.isFinite(size)) return {
		value: DEFAULT_PAGE_SIZE,
		truncated: true
	};
	if (size < MIN_PAGE_SIZE) return {
		value: MIN_PAGE_SIZE,
		truncated: true
	};
	if (size > MAX_PAGE_SIZE) return {
		value: MAX_PAGE_SIZE,
		truncated: true
	};
	const rounded = Math.round(size);
	return {
		value: rounded,
		truncated: rounded !== size
	};
}
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
function encodeCursor(state) {
	const payload = {
		v: CURSOR_VERSION,
		...state
	};
	const json = JSON.stringify(payload);
	const encoded = base64UrlEncode(json);
	if (encoded.length > CURSOR_LENGTH_WARNING_THRESHOLD) console.warn(`[venomous] Cursor length (${encoded.length}) exceeds ${CURSOR_LENGTH_WARNING_THRESHOLD} characters. This may cause issues with URL length limits.`);
	return encoded;
}
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
function decodeCursor(cursor) {
	let json;
	try {
		json = base64UrlDecode(cursor);
	} catch {
		throw new QueryError("Invalid cursor: failed to decode base64", { code: "VENOMOUS_INVALID_CURSOR" });
	}
	let parsed;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new QueryError("Invalid cursor: failed to parse JSON", { code: "VENOMOUS_INVALID_CURSOR" });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new QueryError("Invalid cursor: expected an object", { code: "VENOMOUS_INVALID_CURSOR" });
	const record = parsed;
	if (record["v"] !== CURSOR_VERSION) throw new QueryError(`Invalid cursor: unsupported version (expected ${CURSOR_VERSION}, got ${String(record["v"])})`, { code: "VENOMOUS_INVALID_CURSOR" });
	const { v: _version,...state } = record;
	return state;
}
/**
* Base64url encode a string (URL-safe, no padding).
*/
function base64UrlEncode(input) {
	const base64 = Buffer.from(input, "utf-8").toString("base64");
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/**
* Base64url decode a string.
* Validates that the input contains only valid base64url characters before decoding.
*/
function base64UrlDecode(input) {
	if (!/^[A-Za-z0-9\-_]*$/.test(input)) throw new Error("Invalid base64url characters");
	let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - base64.length % 4) % 4;
	base64 += "=".repeat(padLength);
	return Buffer.from(base64, "base64").toString("utf-8");
}

//#endregion
//#region src/core/utils/parsers.ts
/**
* Parse a CSV string according to RFC 4180.
* Handles: quoted fields, commas inside quotes, newlines inside quotes, escaped quotes ("").
*
* @param content - Raw CSV string content.
* @param maxRows - Maximum number of data rows to return (excluding header).
* @returns Object with columns and data rows.
*/
function parseCsv(content, maxRows) {
	const text = content.charCodeAt(0) === 65279 ? content.slice(1) : content;
	const rows = parseCsvRows(text, maxRows + 1);
	if (rows.length === 0) return {
		columns: [],
		data: []
	};
	const headerRow = rows[0];
	const columns = headerRow.map((name) => ({
		name: name.trim(),
		type: "string",
		nullable: true
	}));
	const data = [];
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		const record = {};
		for (let j = 0; j < columns.length; j++) record[columns[j].name] = j < row.length ? row[j] : null;
		data.push(record);
	}
	return {
		columns,
		data
	};
}
/**
* Parse CSV text into arrays of string arrays (rows of fields).
* RFC 4180 compliant: handles quoted fields with embedded commas and newlines.
*/
function parseCsvRows(text, maxRows) {
	const rows = [];
	let pos = 0;
	const len = text.length;
	while (pos < len && rows.length < maxRows) {
		const { fields, nextPos } = parseCsvLine(text, pos);
		rows.push(fields);
		pos = nextPos;
	}
	return rows;
}
/**
* Parse one CSV line starting at position `pos`.
* Returns the parsed fields and the position after the line terminator.
*/
function parseCsvLine(text, pos) {
	const fields = [];
	const len = text.length;
	while (pos <= len) {
		if (pos === len) {
			if (fields.length > 0) break;
			fields.push("");
			break;
		}
		const char = text[pos];
		if (char === "\"") {
			let value = "";
			pos++;
			while (pos < len) if (text[pos] === "\"") if (pos + 1 < len && text[pos + 1] === "\"") {
				value += "\"";
				pos += 2;
			} else {
				pos++;
				break;
			}
			else {
				value += text[pos];
				pos++;
			}
			fields.push(value);
			if (pos < len && text[pos] === ",") {
				pos++;
				if (pos === len) fields.push("");
			} else if (pos < len && text[pos] === "\r") {
				pos++;
				if (pos < len && text[pos] === "\n") pos++;
				break;
			} else if (pos < len && text[pos] === "\n") {
				pos++;
				break;
			} else break;
		} else if (char === ",") {
			fields.push("");
			pos++;
			if (pos === len) fields.push("");
		} else if (char === "\r" || char === "\n") {
			if (fields.length === 0) fields.push("");
			if (char === "\r") {
				pos++;
				if (pos < len && text[pos] === "\n") pos++;
			} else pos++;
			break;
		} else {
			let value = "";
			while (pos < len && text[pos] !== "," && text[pos] !== "\r" && text[pos] !== "\n") {
				value += text[pos];
				pos++;
			}
			fields.push(value);
			if (pos < len && text[pos] === ",") {
				pos++;
				if (pos === len) fields.push("");
			} else if (pos < len && text[pos] === "\r") {
				pos++;
				if (pos < len && text[pos] === "\n") pos++;
				break;
			} else if (pos < len && text[pos] === "\n") {
				pos++;
				break;
			} else break;
		}
	}
	return {
		fields,
		nextPos: pos
	};
}
/**
* Parse JSON content for peek.
* Supports JSON arrays and JSONL (newline-delimited JSON).
*
* Security: JSON.parse errors are not propagated as cause to avoid
* leaking file content in error messages.
*/
function parseJson(content, maxRows) {
	const text = content.trim();
	if (text.startsWith("[")) {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new QueryError("Failed to parse JSON array");
		}
		if (!Array.isArray(parsed)) throw new QueryError("Expected JSON array");
		return { data: parsed.slice(0, maxRows) };
	}
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const data = [];
	for (const line of lines) {
		if (data.length >= maxRows) break;
		try {
			data.push(JSON.parse(line));
		} catch {
			throw new QueryError(`Failed to parse JSONL at line ${data.length + 1}`);
		}
	}
	return { data };
}
/**
* Determine file format from extension.
*/
function getFileFormat(path) {
	const lower = path.toLowerCase();
	if (lower.endsWith(".csv")) return "csv";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
	if (lower.endsWith(".json")) return "json";
	return null;
}

//#endregion
export { AuthenticationError, ConnectionError, NotFoundError, PathError, PermissionError, QueryError, VenomousError, decodeCursor, encodeCJK, encodeCursor, getFileFormat, isPathSafe, normalizePath, parseCsv, parseJson, redactAuth, sanitizeError, validatePageSize };
//# sourceMappingURL=index.js.map