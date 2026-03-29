import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCJK, encodeCursor, getFileFormat, normalizePath, parseCsv, parseJson, validatePageSize } from "../core/index.js";
import { Readable } from "node:stream";

//#region src/aws-s3/auth.ts
/**
* Resolve an AWSS3Auth configuration into S3Client SDK options.
*
* The `type` field can be omitted (defaults to `'access-key'`).
*
* @param auth - Auth configuration (required, must contain accessKeyId/secretAccessKey/region).
* @returns S3Client configuration object.
*
* @example
* ```typescript
* const config = resolveAuth({
*   accessKeyId: 'AKIA...',
*   secretAccessKey: '...',
*   region: 'us-east-1',
* });
* // { credentials: { accessKeyId: '...', secretAccessKey: '...' }, region: 'us-east-1' }
*
* // type can also be explicitly provided:
* const config2 = resolveAuth({
*   type: 'access-key',
*   accessKeyId: 'AKIA...',
*   secretAccessKey: '...',
*   region: 'us-east-1',
* });
* ```
*/
function resolveAuth(auth) {
	return {
		credentials: {
			accessKeyId: auth.accessKeyId,
			secretAccessKey: auth.secretAccessKey
		},
		region: auth.region
	};
}

//#endregion
//#region src/aws-s3/path.ts
/**
* Convert a user-facing path to an S3 object key.
*
* Processing:
* 1. If path is empty/undefined, return prefix as-is (root listing).
* 2. Run `normalizePath` for security checks (traversal, absolute path, etc.).
* 3. Encode CJK/non-ASCII characters via `encodeCJK`.
* 4. Prepend prefix if configured.
*
* @param userPath - User-provided relative path.
* @param prefix - Optional bucket prefix (e.g., "data/uploads").
* @returns S3 object key suitable for SDK commands.
*
* @example
* ```typescript
* toS3Key('reports/月次.csv', 'data');
* // 'data/reports/%E6%9C%88%E6%AC%A1.csv'
* ```
*/
function toS3Key(userPath, prefix) {
	const normalizedPrefix = prefix ? stripSlashes(prefix) : "";
	if (userPath === void 0 || userPath === null || userPath.trim() === "") return normalizedPrefix ? `${normalizedPrefix}/` : "";
	const safe = normalizePath(userPath);
	const encoded = encodeCJK(safe);
	if (normalizedPrefix) return `${normalizedPrefix}/${encoded}`;
	return encoded;
}
/**
* Convert an S3 object key back to a user-facing path.
*
* Processing:
* 1. Strip the prefix from the key.
* 2. Decode percent-encoded CJK characters.
* 3. Strip trailing slashes (directory markers).
*
* @param s3Key - S3 object key from SDK response.
* @param prefix - Optional bucket prefix to strip.
* @returns User-facing path with decoded Unicode characters.
*
* @example
* ```typescript
* fromS3Key('data/reports/%E6%9C%88%E6%AC%A1.csv', 'data');
* // 'reports/月次.csv'
* ```
*/
function fromS3Key(s3Key, prefix) {
	const normalizedPrefix = prefix ? stripSlashes(prefix) : "";
	let relative = s3Key;
	if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) relative = relative.slice(normalizedPrefix.length + 1);
	try {
		relative = decodeURIComponent(relative);
	} catch {}
	relative = relative.replace(/\/+$/, "");
	return relative;
}
/**
* Build a directory prefix for S3 ListObjectsV2.
* Ensures the prefix ends with '/' for directory listing.
*
* @param userPath - User-provided directory path (optional).
* @param prefix - Bucket-level prefix (optional).
* @returns S3 prefix string ending with '/' for directory scoping.
*/
function toS3Prefix(userPath, prefix) {
	const key = toS3Key(userPath, prefix);
	if (key === "") return "";
	return key.endsWith("/") ? key : `${key}/`;
}
/**
* Strip leading and trailing slashes from a string.
*/
function stripSlashes(s) {
	return s.replace(/^\/+|\/+$/g, "");
}

//#endregion
//#region src/aws-s3/connector.ts
const CONNECTOR_NAME = "aws-s3";
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1e3;
const PEEK_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;
/**
* Map S3 SDK errors to appropriate VenomousError subclasses.
*/
function wrapError(err, defaultMessage) {
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const errName = err.name;
		if (errName === "NoSuchBucket" || errName === "NotFound" || errName === "NoSuchKey") throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errName === "AccessDenied" || errName === "Forbidden") throw new PermissionError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errName === "InvalidAccessKeyId" || errName === "SignatureDoesNotMatch" || errName === "ExpiredToken" || errName === "InvalidToken" || errName === "CredentialsProviderError") throw new AuthenticationError(`AWS S3 authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		const statusCode = err.$metadata?.httpStatusCode;
		if (statusCode === 401) throw new AuthenticationError(`AWS S3 authentication failed: ${message}`, {
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
		if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND") || message.includes("NetworkingError") || errName === "NetworkingError") throw new ConnectionError(`AWS S3 connection failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`AWS S3 operation failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}
/**
* AWSS3Connector implements FileConnector for Amazon S3.
*
* You must provide `{ accessKeyId, secretAccessKey, region }` to `connect()`.
*
* @example
* ```typescript
* import { createAWSS3Connector } from 'venomous-datasource/aws-s3';
*
* const connector = createAWSS3Connector({ bucket: 'my-bucket', prefix: 'data/' });
* await connector.connect({
*   accessKeyId: 'AKIA...',
*   secretAccessKey: '...',
*   region: 'ap-northeast-1',
* });
* const files = await connector.files('reports/');
* const preview = await connector.peek('reports/sales.csv', { rows: 5 });
* const stream = await connector.read('reports/sales.csv');
* await connector.disconnect();
* ```
*/
var AWSS3Connector = class {
	bucket;
	prefix;
	client = null;
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
	}
	/**
	* Ensure the connector is in a connected state.
	*/
	ensureConnected() {
		if (!this.connected || !this.client) throw new ConnectionError("Not connected. Call connect() first.", {
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
		if (!auth) throw new AuthenticationError("AWS S3 requires explicit authentication. Provide { type: \"access-key\", accessKeyId, secretAccessKey, region }.", {
			code: "VENOMOUS_AUTH_REQUIRED",
			connector: CONNECTOR_NAME
		});
		const sdkConfig = { ...resolveAuth(auth) };
		this.client = new S3Client(sdkConfig);
		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
		} catch (err) {
			this.client.destroy();
			this.client = null;
			wrapError(err, `Failed to connect to AWS S3 bucket "${this.bucket}"`);
		}
		this.connected = true;
	}
	async disconnect() {
		for (const controller of this.activeStreams) controller.abort();
		this.activeStreams.clear();
		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
		this.connected = false;
	}
	async files(path, options) {
		this.ensureConnected();
		const s3Prefix = toS3Prefix(path, this.prefix);
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
			const response = await this.client.send(new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: s3Prefix || void 0,
				Delimiter: "/",
				MaxKeys: pageSize,
				ContinuationToken: continuationToken
			}));
			const data = [];
			if (response.CommonPrefixes) for (const prefix of response.CommonPrefixes) {
				if (!prefix.Prefix) continue;
				const userPath = fromS3Key(prefix.Prefix, this.prefix);
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
			if (response.Contents) for (const obj of response.Contents) {
				if (!obj.Key) continue;
				if (obj.Key === s3Prefix) continue;
				const userPath = fromS3Key(obj.Key, this.prefix);
				if (!userPath) continue;
				const name = userPath.split("/").pop() ?? userPath;
				data.push({
					name,
					path: userPath,
					size: obj.Size ?? 0,
					lastModified: obj.LastModified ?? new Date(0),
					contentType: void 0,
					isDirectory: false
				});
			}
			const hasMore = response.IsTruncated ?? false;
			const nextCursor = hasMore && response.NextContinuationToken ? encodeCursor({ token: response.NextContinuationToken }) : void 0;
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
		const s3Key = toS3Key(path, this.prefix);
		let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		if (rows < 1) rows = 1;
		if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;
		const format = getFileFormat(path);
		if (!format) throw new QueryError(`Unsupported file format for peek: "${path}". Supported: .csv, .json, .jsonl, .ndjson`, {
			code: "VENOMOUS_UNSUPPORTED_FORMAT",
			connector: CONNECTOR_NAME
		});
		try {
			const headResponse = await this.client.send(new HeadObjectCommand({
				Bucket: this.bucket,
				Key: s3Key
			}));
			const contentLength = headResponse.ContentLength ?? 0;
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
			const response = await this.client.send(new GetObjectCommand({
				Bucket: this.bucket,
				Key: s3Key
			}));
			if (!response.Body) throw new NotFoundError(`File body is empty: "${path}"`, { connector: CONNECTOR_NAME });
			content = await response.Body.transformToString("utf-8");
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
		const s3Key = toS3Key(path, this.prefix);
		const { controller } = this.trackStream();
		try {
			const response = await this.client.send(new GetObjectCommand({
				Bucket: this.bucket,
				Key: s3Key
			}), { abortSignal: controller.signal });
			if (!response.Body) {
				this.untrackStream(controller);
				throw new NotFoundError(`File body is empty: "${path}"`, { connector: CONNECTOR_NAME });
			}
			const sdkWebStream = response.Body.transformToWebStream();
			const reader = sdkWebStream.getReader();
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
		const s3Key = toS3Key(path, this.prefix);
		const userPath = path;
		const name = userPath.split("/").pop() ?? userPath;
		try {
			const response = await this.client.send(new HeadObjectCommand({
				Bucket: this.bucket,
				Key: s3Key
			}));
			return {
				name,
				path: userPath,
				size: response.ContentLength ?? 0,
				lastModified: response.LastModified ?? new Date(0),
				contentType: response.ContentType,
				isDirectory: false
			};
		} catch (err) {
			wrapError(err, `Failed to get file info: "${path}"`);
		}
	}
	async write(path, data) {
		this.ensureConnected();
		const s3Key = toS3Key(path, this.prefix);
		let body;
		if (data instanceof ReadableStream) body = Readable.fromWeb(data);
		else body = data;
		try {
			await this.client.send(new PutObjectCommand({
				Bucket: this.bucket,
				Key: s3Key,
				Body: body
			}));
			let size;
			if (typeof data === "string") size = Buffer.byteLength(data, "utf-8");
			else if (Buffer.isBuffer(data)) size = data.length;
			else {
				const headResponse = await this.client.send(new HeadObjectCommand({
					Bucket: this.bucket,
					Key: s3Key
				}));
				size = headResponse.ContentLength ?? 0;
			}
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
		const s3Key = toS3Key(path, this.prefix);
		try {
			await this.client.send(new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: s3Key
			}));
		} catch (err) {
			wrapError(err, `Failed to delete file: "${path}"`);
		}
	}
};

//#endregion
//#region src/aws-s3/index.ts
/**
* Create an AWS S3 connector instance.
*
* @param options - Connection options (bucket, prefix, region).
* @returns An unconnected FileConnector. Call `connect()` before use.
*
* @example
* ```typescript
* import { createAWSS3Connector } from 'venomous-datasource/aws-s3';
*
* const connector = createAWSS3Connector({
*   bucket: 'my-bucket',
*   prefix: 'data/',
* });
*
* // AWS S3 requires explicit credentials
* await connector.connect({
*   accessKeyId: 'AKIA...',
*   secretAccessKey: '...',
*   region: 'ap-northeast-1',
* });
* const files = await connector.files('reports/');
* await connector.disconnect();
* ```
*/
function createAWSS3Connector(options) {
	return new AWSS3Connector(options);
}

//#endregion
export { AWSS3Connector, createAWSS3Connector };
//# sourceMappingURL=index.js.map