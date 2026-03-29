import { Storage } from "@google-cloud/storage";
import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, getFileFormat, normalizePath, parseCsv, parseJson, validatePageSize } from "../core/index.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

//#region src/google-cloud-storage/auth.ts
/**
* Resolve a GoogleCloudStorageAuth configuration into Google Cloud Storage SDK options.
*
* @param auth - Auth configuration (credentials required).
* @param projectId - Optional GCP project ID override.
* @returns StorageOptions for the Storage constructor.
*
* @example
* ```typescript
* const config = resolveAuth({ credentials: {...} });
* // { credentials: {...} }
*
* const config2 = resolveAuth({ credentials: {...} }, 'my-project');
* // { projectId: 'my-project', credentials: {...} }
* ```
*/
function resolveAuth(auth, projectId) {
	const base = {};
	if (projectId) base.projectId = projectId;
	return {
		...base,
		credentials: auth.credentials
	};
}

//#endregion
//#region src/google-cloud-storage/path.ts
/**
* Convert a user-facing path to a Google Cloud Storage object name.
*
* Unlike S3, Google Cloud Storage natively supports UTF-8 keys, so NO percent-encoding is applied.
* Only NFC normalization (via `normalizePath`) is performed.
*
* @param userPath - User-provided relative path.
* @param prefix - Optional bucket prefix (e.g., "data/uploads").
* @returns Google Cloud Storage object name suitable for SDK calls.
*
* @example
* ```typescript
* toGoogleCloudStoragePath('reports/月次.csv', 'data');
* // 'data/reports/月次.csv'  (no percent-encoding, unlike S3)
* ```
*/
function toGoogleCloudStoragePath(userPath, prefix) {
	const normalizedPrefix = prefix ? stripSlashes(prefix) : "";
	if (userPath === void 0 || userPath === null || userPath.trim() === "") return normalizedPrefix ? `${normalizedPrefix}/` : "";
	const safe = normalizePath(userPath);
	if (normalizedPrefix) return `${normalizedPrefix}/${safe}`;
	return safe;
}
/**
* Convert a Google Cloud Storage object name back to a user-facing path.
*
* @param googleCloudStoragePath - Google Cloud Storage object name from SDK response.
* @param prefix - Optional bucket prefix to strip.
* @returns User-facing path with original Unicode characters preserved.
*
* @example
* ```typescript
* fromGoogleCloudStoragePath('data/reports/月次.csv', 'data');
* // 'reports/月次.csv'
* ```
*/
function fromGoogleCloudStoragePath(googleCloudStoragePath, prefix) {
	let relative = googleCloudStoragePath.normalize("NFC");
	const normalizedPrefix = prefix ? stripSlashes(prefix).normalize("NFC") : "";
	if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) relative = relative.slice(normalizedPrefix.length + 1);
	else if (normalizedPrefix && relative === normalizedPrefix) relative = "";
	relative = relative.replace(/\/+$/, "");
	return relative;
}
/**
* Build a directory prefix for Google Cloud Storage getFiles().
* Ensures the prefix ends with '/' for directory listing.
*
* @param userPath - User-provided directory path (optional).
* @param prefix - Bucket-level prefix (optional).
* @returns Google Cloud Storage prefix string ending with '/' for directory scoping.
*/
function toGoogleCloudStoragePrefix(userPath, prefix) {
	const path = toGoogleCloudStoragePath(userPath, prefix);
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
//#region src/google-cloud-storage/connector.ts
const CONNECTOR_NAME = "google-cloud-storage";
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1e3;
const PEEK_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;
/**
* Map Google Cloud Storage SDK errors to appropriate VenomousError subclasses.
*
* Error mapping:
* - 401 -> AuthenticationError
* - 403 -> PermissionError (NOT AuthenticationError)
* - 404 -> NotFoundError
* - Network errors -> ConnectionError
* - Others -> QueryError
*/
function wrapError(err, defaultMessage) {
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const statusCode = err.code;
		if (statusCode === 401) throw new AuthenticationError(`Google Cloud Storage authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (statusCode === 403) throw new PermissionError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (statusCode === 404) throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		const codeStr = typeof statusCode === "string" ? statusCode : "";
		if (codeStr === "UNAUTHENTICATED") throw new AuthenticationError(`Google Cloud Storage authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (codeStr === "PERMISSION_DENIED") throw new PermissionError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (codeStr === "NOT_FOUND") throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND") || message.includes("NetworkingError")) throw new ConnectionError(`Google Cloud Storage connection failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`Google Cloud Storage operation failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}
/**
* GoogleCloudStorageConnector implements FileConnector for Google Cloud Storage.
*
* Key difference from S3: Google Cloud Storage natively supports UTF-8 object names,
* so NO percent-encoding is applied to CJK/Unicode paths. Only NFC
* normalization is performed for consistency.
*
* @example
* ```typescript
* import { createGoogleCloudStorageConnector } from 'venomous-datasource/google-cloud-storage';
*
* const connector = createGoogleCloudStorageConnector({ bucket: 'my-bucket', prefix: 'data/' });
* await connector.connect({ credentials: serviceAccountJson });
* const files = await connector.files('reports/');
* const preview = await connector.peek('reports/sales.csv', { rows: 5 });
* const stream = await connector.read('reports/sales.csv');
* await connector.disconnect();
* ```
*/
var GoogleCloudStorageConnector = class {
	bucket;
	prefix;
	projectId;
	storage = null;
	bucketHandle = null;
	connected = false;
	/** Active stream abort controllers for resource cleanup. */
	activeStreams = new Set();
	constructor(options) {
		if (!options.bucket || options.bucket.trim() === "") throw new ConnectionError("bucket is required", {
			code: "VENOMOUS_INVALID_OPTIONS",
			connector: CONNECTOR_NAME
		});
		this.bucket = options.bucket;
		this.prefix = options.prefix;
		this.projectId = options.projectId;
	}
	/**
	* Ensure the connector is in a connected state.
	*/
	ensureConnected() {
		if (!this.connected || !this.storage || !this.bucketHandle) throw new ConnectionError("Not connected. Call connect() first.", {
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
		if (!auth) throw new AuthenticationError("Google Cloud Storage requires explicit authentication. Provide { credentials: <service-account-json> }.", {
			code: "VENOMOUS_AUTH_REQUIRED",
			connector: CONNECTOR_NAME
		});
		const storageOptions = resolveAuth(auth, this.projectId);
		this.storage = new Storage(storageOptions);
		this.bucketHandle = this.storage.bucket(this.bucket);
		try {
			const [exists] = await this.bucketHandle.exists();
			if (!exists) {
				this.storage = null;
				this.bucketHandle = null;
				throw new NotFoundError(`Bucket "${this.bucket}" does not exist`, { connector: CONNECTOR_NAME });
			}
		} catch (err) {
			this.storage = null;
			this.bucketHandle = null;
			if (err instanceof NotFoundError) throw err;
			wrapError(err, `Failed to connect to Google Cloud Storage bucket "${this.bucket}"`);
		}
		this.connected = true;
	}
	async disconnect() {
		for (const controller of this.activeStreams) controller.abort();
		this.activeStreams.clear();
		this.storage = null;
		this.bucketHandle = null;
		this.connected = false;
	}
	async files(path, options) {
		this.ensureConnected();
		const googleCloudStoragePrefix = toGoogleCloudStoragePrefix(path, this.prefix);
		const pageSize = options?.page?.size ? validatePageSize(options.page.size).value : DEFAULT_PAGE_SIZE;
		let pageToken;
		if (options?.page?.cursor) {
			const state = decodeCursor(options.page.cursor);
			if (typeof state["token"] !== "string") throw new QueryError("Invalid cursor: missing token", {
				code: "VENOMOUS_INVALID_CURSOR",
				connector: CONNECTOR_NAME
			});
			pageToken = state["token"];
		}
		try {
			const [files, queryResponse, apiResponse] = await this.bucketHandle.getFiles({
				prefix: googleCloudStoragePrefix || void 0,
				delimiter: "/",
				maxResults: pageSize,
				pageToken,
				autoPaginate: false
			});
			const data = [];
			const prefixes = apiResponse?.prefixes;
			if (prefixes) for (const dirPrefix of prefixes) {
				const userPath = fromGoogleCloudStoragePath(dirPrefix, this.prefix);
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
			for (const file of files) {
				if (file.name === googleCloudStoragePrefix) continue;
				const userPath = fromGoogleCloudStoragePath(file.name, this.prefix);
				if (!userPath) continue;
				const name = userPath.split("/").filter(Boolean).pop() ?? userPath;
				const metadata = file.metadata;
				data.push({
					name,
					path: userPath,
					size: metadata.size ? Number(metadata.size) : 0,
					lastModified: metadata.updated ? new Date(metadata.updated) : new Date(0),
					contentType: metadata.contentType,
					isDirectory: false
				});
			}
			const nextPageToken = queryResponse?.pageToken;
			const hasMore = !!nextPageToken;
			const nextCursor = hasMore ? encodeCursor({ token: nextPageToken }) : void 0;
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
		const googleCloudStoragePath = toGoogleCloudStoragePath(path, this.prefix);
		let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		if (rows < 1) rows = 1;
		if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;
		const format = getFileFormat(path);
		if (!format) throw new QueryError(`Unsupported file format for peek: "${path}". Supported: .csv, .json, .jsonl, .ndjson`, {
			code: "VENOMOUS_UNSUPPORTED_FORMAT",
			connector: CONNECTOR_NAME
		});
		const file = this.bucketHandle.file(googleCloudStoragePath);
		try {
			const [metadata] = await file.getMetadata();
			const contentLength = metadata.size ? Number(metadata.size) : 0;
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
			const [buffer] = await file.download();
			content = buffer.toString("utf-8");
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
		const googleCloudStoragePath = toGoogleCloudStoragePath(path, this.prefix);
		const { controller } = this.trackStream();
		const file = this.bucketHandle.file(googleCloudStoragePath);
		try {
			const [exists] = await file.exists();
			if (!exists) {
				this.untrackStream(controller);
				throw new NotFoundError(`File not found: "${path}"`, { connector: CONNECTOR_NAME });
			}
			const nodeStream = file.createReadStream();
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
			wrapError(err, `Failed to read file: "${path}"`);
		}
	}
	async stat(path) {
		this.ensureConnected();
		const googleCloudStoragePath = toGoogleCloudStoragePath(path, this.prefix);
		const file = this.bucketHandle.file(googleCloudStoragePath);
		const userPath = path;
		const name = userPath.split("/").pop() ?? userPath;
		try {
			const [metadata] = await file.getMetadata();
			return {
				name,
				path: userPath,
				size: metadata.size ? Number(metadata.size) : 0,
				lastModified: metadata.updated ? new Date(metadata.updated) : new Date(0),
				contentType: metadata.contentType,
				isDirectory: false
			};
		} catch (err) {
			wrapError(err, `Failed to get file info: "${path}"`);
		}
	}
	async write(path, data) {
		this.ensureConnected();
		const googleCloudStoragePath = toGoogleCloudStoragePath(path, this.prefix);
		const file = this.bucketHandle.file(googleCloudStoragePath);
		try {
			if (data instanceof ReadableStream) {
				const nodeStream = Readable.fromWeb(data);
				const writeStream = file.createWriteStream();
				await pipeline(nodeStream, writeStream);
				const [metadata] = await file.getMetadata();
				return {
					path,
					size: metadata.size ? Number(metadata.size) : 0
				};
			}
			await file.save(data);
			let size;
			if (typeof data === "string") size = Buffer.byteLength(data, "utf-8");
			else size = data.length;
			return {
				path,
				size
			};
		} catch (err) {
			wrapError(err, `Failed to write file: "${path}"`);
		}
	}
	async remove(path) {
		this.ensureConnected();
		const googleCloudStoragePath = toGoogleCloudStoragePath(path, this.prefix);
		const file = this.bucketHandle.file(googleCloudStoragePath);
		try {
			await file.delete();
		} catch (err) {
			if (err instanceof Error && err.code === 404) return;
			wrapError(err, `Failed to delete file: "${path}"`);
		}
	}
};

//#endregion
//#region src/google-cloud-storage/index.ts
/**
* Create a Google Cloud Storage connector instance.
*
* Google Cloud Storage requires explicit credentials — `connect()` without
* auth will throw `AuthenticationError`.
*
* @param options - Connection options (bucket, prefix, projectId).
* @returns An unconnected FileConnector. Call `connect()` before use.
*
* @example
* ```typescript
* import { createGoogleCloudStorageConnector } from 'venomous-datasource/google-cloud-storage';
*
* const connector = createGoogleCloudStorageConnector({
*   bucket: 'my-bucket',
*   prefix: 'data/',
*   projectId: 'my-project',
* });
*
* await connector.connect({ credentials: serviceAccountJson });
* const files = await connector.files('reports/');
* await connector.disconnect();
* ```
*/
function createGoogleCloudStorageConnector(options) {
	return new GoogleCloudStorageConnector(options);
}

//#endregion
export { GoogleCloudStorageConnector, createGoogleCloudStorageConnector };
//# sourceMappingURL=index.js.map