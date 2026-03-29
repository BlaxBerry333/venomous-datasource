import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, getFileFormat, normalizePath, parseCsv, parseJson, validatePageSize } from "../core/index.js";
import { BlobServiceClient } from "@azure/storage-blob";
import { Readable } from "node:stream";

//#region src/azure-blob-storage/auth.ts
const CONNECTOR_NAME$1 = "azure-blob-storage";
/**
* Build the Azure Blob Storage endpoint URL from an account name.
*/
function buildAccountUrl(accountName) {
	return `https://${accountName}.blob.core.windows.net`;
}
/**
* Resolve an AzureBlobStorageAuth configuration into a BlobServiceClient.
*
* Azure SDK's BlobServiceClient construction varies significantly by auth type,
* so this function returns the fully constructed client.
*
* @param auth - Auth configuration. Must be provided explicitly.
* @returns Object containing the constructed BlobServiceClient.
* @throws {AuthenticationError} When auth is undefined.
*/
async function resolveAuth(auth) {
	if (!auth) throw new AuthenticationError("Authentication is required. Provide { type: 'connection-string', connectionString } or { type: 'sas-token', accountName, sasToken }.", {
		code: "VENOMOUS_AUTH_REQUIRED",
		connector: CONNECTOR_NAME$1
	});
	if (auth.type === "connection-string") {
		const client = BlobServiceClient.fromConnectionString(auth.connectionString);
		return { client };
	}
	if (auth.type === "sas-token") {
		const token = auth.sasToken.replace(/^\?/, "");
		const url = `${buildAccountUrl(auth.accountName)}?${token}`;
		const client = new BlobServiceClient(url);
		return { client };
	}
	const _exhaustive = auth;
	throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}

//#endregion
//#region src/azure-blob-storage/path.ts
/**
* Convert a user-facing path to an Azure Blob name.
*
* Azure Blob Storage natively supports UTF-8 blob names, so NO percent-encoding
* is applied. Only NFC normalization (via `normalizePath`) is performed.
* Logic is identical to Google Cloud Storage path handling.
*
* @param userPath - User-provided relative path.
* @param prefix - Optional container prefix (e.g., "data/uploads").
* @returns Blob name suitable for SDK calls.
*
* @example
* ```typescript
* toBlobPath('reports/月次.csv', 'data');
* // 'data/reports/月次.csv'
* ```
*/
function toBlobPath(userPath, prefix) {
	const normalizedPrefix = prefix ? stripSlashes(prefix) : "";
	if (userPath === void 0 || userPath === null || userPath.trim() === "") return normalizedPrefix ? `${normalizedPrefix}/` : "";
	const safe = normalizePath(userPath);
	if (normalizedPrefix) return `${normalizedPrefix}/${safe}`;
	return safe;
}
/**
* Convert an Azure Blob name back to a user-facing path.
*
* @param blobName - Blob name from SDK response.
* @param prefix - Optional container prefix to strip.
* @returns User-facing path with original Unicode characters preserved.
*
* @example
* ```typescript
* fromBlobPath('data/reports/月次.csv', 'data');
* // 'reports/月次.csv'
* ```
*/
function fromBlobPath(blobName, prefix) {
	let relative = blobName.normalize("NFC");
	const normalizedPrefix = prefix ? stripSlashes(prefix).normalize("NFC") : "";
	if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) relative = relative.slice(normalizedPrefix.length + 1);
	else if (normalizedPrefix && relative === normalizedPrefix) relative = "";
	relative = relative.replace(/\/+$/, "");
	return relative;
}
/**
* Build a directory prefix for Azure Blob listing.
* Ensures the prefix ends with '/' for directory scoping.
*
* @param userPath - User-provided directory path (optional).
* @param prefix - Container-level prefix (optional).
* @returns Blob prefix string ending with '/' for directory listing.
*/
function toBlobPrefix(userPath, prefix) {
	const path = toBlobPath(userPath, prefix);
	if (path === "") return "";
	return path.endsWith("/") ? path : `${path}/`;
}
/**
* Strip leading and trailing slashes from a string.
*/
function stripSlashes(s) {
	return s.replace(/^\/+|\/+$/g, "");
}

//#endregion
//#region src/azure-blob-storage/connector.ts
const CONNECTOR_NAME = "azure-blob-storage";
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1e3;
const PEEK_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;
const UPLOAD_BUFFER_SIZE = 4 * 1024 * 1024;
const UPLOAD_MAX_CONCURRENCY = 4;
/**
* MIME type mapping for common file extensions.
* Azure Blob Storage does not auto-detect Content-Type, so we infer it.
*/
const MIME_TYPES = {
	".csv": "text/csv",
	".json": "application/json",
	".jsonl": "application/x-ndjson",
	".ndjson": "application/x-ndjson",
	".txt": "text/plain",
	".html": "text/html",
	".xml": "application/xml",
	".parquet": "application/octet-stream"
};
/**
* Infer Content-Type from file extension.
*/
function inferContentType(path) {
	const dotIndex = path.lastIndexOf(".");
	if (dotIndex === -1) return "application/octet-stream";
	const ext = path.slice(dotIndex).toLowerCase();
	return MIME_TYPES[ext] ?? "application/octet-stream";
}
/**
* Sanitize an error cause to prevent SAS token leakage.
*
* Azure SDK's RestError may include the full request URL (with SAS token)
* in its `request` property. We create a minimal cause that only preserves
* safe diagnostic fields.
*/
function sanitizeCause(err) {
	if (err instanceof Error && "statusCode" in err) {
		const restErr = err;
		const sanitized = new Error(restErr.message);
		sanitized.name = restErr.name;
		sanitized.statusCode = restErr.statusCode;
		sanitized.code = restErr.code;
		return sanitized;
	}
	return err instanceof Error ? err : new Error(String(err));
}
/**
* Map Azure SDK errors to appropriate VenomousError subclasses.
*
* Error mapping:
* - 401 / AuthenticationFailed / InvalidAuthenticationInfo -> AuthenticationError
* - 403 / AuthorizationFailure -> PermissionError
* - 404 / ContainerNotFound / BlobNotFound -> NotFoundError
* - 409 with ContainerNotFound/BlobNotFound -> NotFoundError
* - Network errors (ECONNREFUSED/ETIMEDOUT/ENOTFOUND) -> ConnectionError
* - Others -> QueryError
*/
function wrapError(err, defaultMessage) {
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const statusCode = err.statusCode;
		const code = err.code;
		const cause = sanitizeCause(err);
		if (statusCode === 401) throw new AuthenticationError(`Azure Blob authentication failed: ${message}`, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (statusCode === 403) throw new PermissionError(message, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (statusCode === 404) throw new NotFoundError(message, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (code === "AuthenticationFailed" || code === "InvalidAuthenticationInfo") throw new AuthenticationError(`Azure Blob authentication failed: ${message}`, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (code === "AuthorizationFailure") throw new PermissionError(message, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (code === "ContainerNotFound" || code === "BlobNotFound") throw new NotFoundError(message, {
			cause,
			connector: CONNECTOR_NAME
		});
		if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) throw new ConnectionError(`Azure Blob connection failed: ${message}`, {
			cause,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`Azure Blob operation failed: ${message}`, {
			cause,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}
/**
* AzureBlobStorageConnector implements FileConnector for Azure Blob Storage.
*
* Uses `@azure/storage-blob` SDK. Azure Blob Storage natively supports UTF-8
* blob names, so NO percent-encoding is applied to CJK/Unicode paths.
* Only NFC normalization is performed for consistency.
*
* @example
* ```typescript
* import { createAzureBlobStorageConnector } from 'venomous-datasource/azure-blob-storage';
*
* const connector = createAzureBlobStorageConnector({
*   container: 'my-container',
*   prefix: 'data/',
* });
* await connector.connect({ type: 'connection-string', connectionString: '...' });
* const files = await connector.files('reports/');
* const preview = await connector.peek('reports/sales.csv', { rows: 5 });
* const stream = await connector.read('reports/sales.csv');
* await connector.disconnect();
* ```
*/
var AzureBlobStorageConnector = class {
	container;
	prefix;
	blobServiceClient = null;
	containerClient = null;
	connected = false;
	/** Active stream abort controllers for resource cleanup. */
	activeStreams = new Set();
	constructor(options) {
		if (!options.container || options.container.trim() === "") throw new ConnectionError("container is required", {
			code: "VENOMOUS_INVALID_OPTIONS",
			connector: CONNECTOR_NAME
		});
		this.container = options.container;
		this.prefix = options.prefix;
	}
	/**
	* Ensure the connector is in a connected state.
	*/
	ensureConnected() {
		if (!this.connected || !this.blobServiceClient || !this.containerClient) throw new ConnectionError("Not connected. Call connect() first.", {
			code: "VENOMOUS_NOT_CONNECTED",
			connector: CONNECTOR_NAME
		});
	}
	/**
	* Track an active stream and return its AbortController signal.
	* Enforces the MAX_ACTIVE_STREAMS limit.
	*/
	trackStream() {
		if (this.activeStreams.size >= MAX_ACTIVE_STREAMS) throw new QueryError(`Too many active streams (limit: ${MAX_ACTIVE_STREAMS}). Close existing streams or call disconnect().`, {
			code: "VENOMOUS_STREAM_LIMIT",
			connector: CONNECTOR_NAME
		});
		const controller = new AbortController();
		this.activeStreams.add(controller);
		return {
			controller,
			signal: controller.signal
		};
	}
	/**
	* Untrack a stream after it's closed.
	*/
	untrackStream(controller) {
		this.activeStreams.delete(controller);
	}
	async connect(auth) {
		const { client } = await resolveAuth(auth);
		this.blobServiceClient = client;
		this.containerClient = client.getContainerClient(this.container);
		try {
			await this.containerClient.getProperties();
		} catch (err) {
			this.blobServiceClient = null;
			this.containerClient = null;
			const code = err.code;
			const statusCode = err.statusCode;
			if (statusCode === 404 || code === "ContainerNotFound") throw new NotFoundError(`Container "${this.container}" does not exist`, { connector: CONNECTOR_NAME });
			wrapError(err, `Failed to connect to Azure Blob container "${this.container}"`);
		}
		this.connected = true;
	}
	async disconnect() {
		for (const controller of this.activeStreams) controller.abort();
		this.activeStreams.clear();
		this.blobServiceClient = null;
		this.containerClient = null;
		this.connected = false;
	}
	async files(path, options) {
		this.ensureConnected();
		const blobPrefix = toBlobPrefix(path, this.prefix);
		const pageSize = options?.page?.size ? validatePageSize(options.page.size).value : DEFAULT_PAGE_SIZE;
		let continuationToken;
		if (options?.page?.cursor) {
			const state = decodeCursor(options.page.cursor);
			if (typeof state["token"] !== "string") throw new QueryError("Invalid cursor: missing token", {
				code: "VENOMOUS_INVALID_CURSOR",
				connector: CONNECTOR_NAME
			});
			continuationToken = state["token"];
		}
		try {
			const iterator = this.containerClient.listBlobsByHierarchy("/", { prefix: blobPrefix || void 0 }).byPage({
				maxPageSize: pageSize,
				continuationToken
			});
			const page = await iterator.next();
			const segment = page.value;
			const data = [];
			const prefixes = segment.segment.blobPrefixes;
			if (prefixes) for (const dirPrefix of prefixes) {
				const userPath = fromBlobPath(dirPrefix.name, this.prefix);
				if (!userPath) continue;
				const name = userPath.split("/").filter(Boolean).pop() ?? userPath;
				data.push({
					name,
					path: userPath,
					size: 0,
					lastModified: new Date(0),
					isDirectory: true
				});
			}
			const blobItems = segment.segment.blobItems;
			if (blobItems) for (const blob of blobItems) {
				if (blob.name === blobPrefix) continue;
				const userPath = fromBlobPath(blob.name, this.prefix);
				if (!userPath) continue;
				const name = userPath.split("/").filter(Boolean).pop() ?? userPath;
				data.push({
					name,
					path: userPath,
					size: blob.properties.contentLength ?? 0,
					lastModified: blob.properties.lastModified ?? new Date(0),
					contentType: blob.properties.contentType,
					isDirectory: false
				});
			}
			const nextToken = segment.continuationToken;
			const hasMore = !!nextToken;
			const nextCursor = hasMore ? encodeCursor({ token: nextToken }) : void 0;
			return {
				data,
				nextCursor,
				hasMore
			};
		} catch (err) {
			wrapError(err, "Failed to list files");
		}
	}
	async peek(path, options) {
		this.ensureConnected();
		const blobPath = toBlobPath(path, this.prefix);
		let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		if (rows < 1) rows = 1;
		if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;
		const format = getFileFormat(path);
		if (!format) throw new QueryError(`Unsupported file format for peek: "${path}". Supported: .csv, .json, .jsonl, .ndjson`, {
			code: "VENOMOUS_UNSUPPORTED_FORMAT",
			connector: CONNECTOR_NAME
		});
		const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
		try {
			const properties = await blockBlobClient.getProperties();
			const contentLength = properties.contentLength ?? 0;
			if (contentLength > PEEK_MAX_BYTES) throw new QueryError(`File too large for peek (${Math.round(contentLength / 1024 / 1024)}MB, limit: ${PEEK_MAX_BYTES / 1024 / 1024}MB). Use read() for streaming.`, {
				code: "VENOMOUS_FILE_TOO_LARGE",
				connector: CONNECTOR_NAME
			});
		} catch (err) {
			if (err instanceof QueryError) throw err;
			wrapError(err, `Failed to check file size: "${path}"`);
		}
		let content;
		try {
			const response = await blockBlobClient.download(0);
			const body = response.readableStreamBody;
			if (!body) throw new QueryError(`Failed to read file: "${path}" (no stream body)`, { connector: CONNECTOR_NAME });
			const chunks = [];
			for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			content = Buffer.concat(chunks).toString("utf-8");
		} catch (err) {
			if (err instanceof QueryError || err instanceof NotFoundError) throw err;
			wrapError(err, `Failed to read file: "${path}"`);
		}
		if (format === "csv") {
			const result = parseCsv(content, rows);
			return {
				data: result.data,
				columns: result.columns.length > 0 ? result.columns : void 0
			};
		}
		try {
			const result = parseJson(content, rows);
			let columns;
			if (result.data.length > 0) {
				const firstRow = result.data[0];
				columns = Object.keys(firstRow).map((key) => ({
					name: key,
					type: typeof firstRow[key] === "number" ? "number" : typeof firstRow[key] === "boolean" ? "boolean" : "string",
					nullable: true
				}));
			}
			return {
				data: result.data,
				columns
			};
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw new QueryError(`Failed to parse ${format.toUpperCase()} file: "${path}". Check file format and content.`, { connector: CONNECTOR_NAME });
		}
	}
	async read(path) {
		this.ensureConnected();
		const blobPath = toBlobPath(path, this.prefix);
		const { controller } = this.trackStream();
		const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
		try {
			const response = await blockBlobClient.download(0);
			const body = response.readableStreamBody;
			if (!body) {
				this.untrackStream(controller);
				throw new NotFoundError(`File not found: "${path}"`, { connector: CONNECTOR_NAME });
			}
			const nodeStream = body;
			controller.signal.addEventListener("abort", () => {
				nodeStream.destroy();
			}, { once: true });
			const webStream = Readable.toWeb(nodeStream);
			const reader = webStream.getReader();
			const untrack = () => this.untrackStream(controller);
			return new ReadableStream({
				async pull(ctrl) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							untrack();
							ctrl.close();
						} else ctrl.enqueue(value);
					} catch (err) {
						untrack();
						ctrl.error(err);
					}
				},
				cancel() {
					reader.cancel();
					untrack();
				}
			});
		} catch (err) {
			this.untrackStream(controller);
			if (err instanceof NotFoundError) throw err;
			const statusCode = err.statusCode;
			const code = err.code;
			if (statusCode === 404 || code === "BlobNotFound") throw new NotFoundError(`File not found: "${path}"`, { connector: CONNECTOR_NAME });
			wrapError(err, `Failed to read file: "${path}"`);
		}
	}
	async stat(path) {
		this.ensureConnected();
		const blobPath = toBlobPath(path, this.prefix);
		const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
		const userPath = path;
		const name = userPath.split("/").pop() ?? userPath;
		try {
			const properties = await blockBlobClient.getProperties();
			return {
				name,
				path: userPath,
				size: properties.contentLength ?? 0,
				lastModified: properties.lastModified ?? new Date(0),
				contentType: properties.contentType,
				isDirectory: false
			};
		} catch (err) {
			wrapError(err, `Failed to get file info: "${path}"`);
		}
	}
	async write(path, data) {
		this.ensureConnected();
		const blobPath = toBlobPath(path, this.prefix);
		const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
		const contentType = inferContentType(path);
		const blobHTTPHeaders = { blobContentType: contentType };
		try {
			if (data instanceof ReadableStream) {
				const nodeStream = Readable.fromWeb(data);
				await blockBlobClient.uploadStream(nodeStream, UPLOAD_BUFFER_SIZE, UPLOAD_MAX_CONCURRENCY, { blobHTTPHeaders });
				const properties = await blockBlobClient.getProperties();
				return {
					path,
					size: properties.contentLength ?? 0
				};
			}
			let body;
			if (typeof data === "string") body = Buffer.from(data, "utf-8");
			else body = data;
			await blockBlobClient.upload(body, body.length, { blobHTTPHeaders });
			return {
				path,
				size: body.length
			};
		} catch (err) {
			wrapError(err, `Failed to write file: "${path}"`);
		}
	}
	async remove(path) {
		this.ensureConnected();
		const blobPath = toBlobPath(path, this.prefix);
		try {
			await this.containerClient.deleteBlob(blobPath);
		} catch (err) {
			const statusCode = err.statusCode;
			const code = err.code;
			if (statusCode === 404 || code === "BlobNotFound") return;
			wrapError(err, `Failed to delete file: "${path}"`);
		}
	}
};

//#endregion
//#region src/azure-blob-storage/index.ts
/**
* Create an Azure Blob Storage connector instance.
*
* @param options - Connection options (container, prefix, accountName).
* @returns An unconnected FileConnector. Call `connect()` before use.
*
* @example
* ```typescript
* import { createAzureBlobStorageConnector } from 'venomous-datasource/azure-blob-storage';
*
* const connector = createAzureBlobStorageConnector({
*   container: 'my-container',
*   prefix: 'data/',
* });
*
* await connector.connect({ type: 'connection-string', connectionString: '...' });
* const files = await connector.files('reports/');
* await connector.disconnect();
* ```
*/
function createAzureBlobStorageConnector(options) {
	return new AzureBlobStorageConnector(options);
}

//#endregion
export { AzureBlobStorageConnector, createAzureBlobStorageConnector };
//# sourceMappingURL=index.js.map