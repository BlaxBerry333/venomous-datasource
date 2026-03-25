import { Storage } from '@google-cloud/storage';
import type { Bucket } from '@google-cloud/storage';
import type {
  FileConnector,
  GCSAuth,
  FileInfo,
  PeekResult,
  WriteResult,
  PageResult,
  PeekOptions,
  ListOptions,
  ColumnInfo,
} from '../core/index.js';
import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  QueryError,
  validatePageSize,
  encodeCursor,
  decodeCursor,
} from '../core/index.js';
import { resolveAuth } from './auth.js';
import { toGCSPath, fromGCSPath, toGCSPrefix } from './path.js';
import { parseCsv, parseJson, getFileFormat } from '../core/index.js';
import type { GCSOptions } from './types.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CONNECTOR_NAME = 'gcs';
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1000;
const PEEK_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Map GCS SDK errors to appropriate VenomousError subclasses.
 *
 * Error mapping:
 * - 401 -> AuthenticationError
 * - 403 -> PermissionError (NOT AuthenticationError)
 * - 404 -> NotFoundError
 * - Network errors -> ConnectionError
 * - Others -> QueryError
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof Error) {
    const message = err.message || defaultMessage;

    // GCS SDK uses HTTP status codes in error responses.
    // The code may also be a string for gRPC error codes.
    const statusCode = (err as { code?: number | string }).code;

    if (statusCode === 401) {
      throw new AuthenticationError(`GCS authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (statusCode === 403) {
      throw new PermissionError(message, { cause: err, connector: CONNECTOR_NAME });
    }

    if (statusCode === 404) {
      throw new NotFoundError(message, { cause: err, connector: CONNECTOR_NAME });
    }

    // String-based gRPC error codes (future-proofing for gRPC transport)
    const codeStr = typeof statusCode === 'string' ? statusCode : '';
    if (codeStr === 'UNAUTHENTICATED') {
      throw new AuthenticationError(`GCS authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }
    if (codeStr === 'PERMISSION_DENIED') {
      throw new PermissionError(message, { cause: err, connector: CONNECTOR_NAME });
    }
    if (codeStr === 'NOT_FOUND') {
      throw new NotFoundError(message, { cause: err, connector: CONNECTOR_NAME });
    }

    // Network errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('NetworkingError')
    ) {
      throw new ConnectionError(`GCS connection failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`GCS operation failed: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}

/**
 * GCSConnector implements FileConnector for Google Cloud Storage.
 *
 * Key difference from S3: GCS natively supports UTF-8 object names,
 * so NO percent-encoding is applied to CJK/Unicode paths. Only NFC
 * normalization is performed for consistency.
 *
 * @example
 * ```typescript
 * import { createGCSConnector } from 'venomous-datasource/gcs';
 *
 * const connector = createGCSConnector({ bucket: 'my-bucket', prefix: 'data/' });
 * await connector.connect(); // uses Application Default Credentials
 * const files = await connector.files('reports/');
 * const preview = await connector.peek('reports/sales.csv', { rows: 5 });
 * const stream = await connector.read('reports/sales.csv');
 * await connector.disconnect();
 * ```
 */
export class GCSConnector implements FileConnector<GCSAuth> {
  private readonly bucket: string;
  private readonly prefix?: string;
  private readonly projectId?: string;
  private storage: Storage | null = null;
  private bucketHandle: Bucket | null = null;
  private connected = false;

  /** Active stream abort controllers for resource cleanup. */
  private activeStreams = new Set<AbortController>();

  constructor(options: GCSOptions) {
    if (!options.bucket || options.bucket.trim() === '') {
      throw new ConnectionError('bucket is required', {
        code: 'VENOMOUS_INVALID_OPTIONS',
        connector: CONNECTOR_NAME,
      });
    }

    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.projectId = options.projectId;
  }

  /**
   * Ensure the connector is in a connected state.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.storage || !this.bucketHandle) {
      throw new ConnectionError('Not connected. Call connect() first.', {
        code: 'VENOMOUS_NOT_CONNECTED',
        connector: CONNECTOR_NAME,
      });
    }
  }

  /**
   * Track an active stream and return its AbortController signal.
   * Enforces the MAX_ACTIVE_STREAMS limit.
   */
  private trackStream(): { controller: AbortController; signal: AbortSignal } {
    if (this.activeStreams.size >= MAX_ACTIVE_STREAMS) {
      throw new QueryError(
        `Too many active streams (limit: ${MAX_ACTIVE_STREAMS}). Close existing streams or call disconnect().`,
        { code: 'VENOMOUS_STREAM_LIMIT', connector: CONNECTOR_NAME }
      );
    }

    const controller = new AbortController();
    this.activeStreams.add(controller);
    return { controller, signal: controller.signal };
  }

  /**
   * Untrack a stream after it's closed.
   */
  private untrackStream(controller: AbortController): void {
    this.activeStreams.delete(controller);
  }

  async connect(auth?: GCSAuth): Promise<void> {
    const storageOptions = resolveAuth(auth, this.projectId);

    this.storage = new Storage(storageOptions);
    this.bucketHandle = this.storage.bucket(this.bucket);

    // Validate connectivity by checking bucket existence
    try {
      const [exists] = await this.bucketHandle.exists();
      if (!exists) {
        this.storage = null;
        this.bucketHandle = null;
        throw new NotFoundError(`Bucket "${this.bucket}" does not exist`, {
          connector: CONNECTOR_NAME,
        });
      }
    } catch (err) {
      this.storage = null;
      this.bucketHandle = null;

      if (err instanceof NotFoundError) throw err;
      wrapError(err, `Failed to connect to GCS bucket "${this.bucket}"`);
    }

    // No redactAuth call needed: connector does not store auth reference.
    // The auth object is only used to create the Storage client above.

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // Abort all active streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    this.storage = null;
    this.bucketHandle = null;
    this.connected = false;
  }

  async files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>> {
    this.ensureConnected();

    const gcsPrefix = toGCSPrefix(path, this.prefix);
    const pageSize = options?.page?.size
      ? validatePageSize(options.page.size).value
      : DEFAULT_PAGE_SIZE;

    let pageToken: string | undefined;
    if (options?.page?.cursor) {
      const state = decodeCursor(options.page.cursor);
      if (typeof state['token'] !== 'string') {
        throw new QueryError('Invalid cursor: missing token', {
          code: 'VENOMOUS_INVALID_CURSOR',
          connector: CONNECTOR_NAME,
        });
      }
      pageToken = state['token'] as string;
    }

    try {
      const [files, queryResponse, apiResponse] = await this.bucketHandle!.getFiles({
        prefix: gcsPrefix || undefined,
        delimiter: '/',
        maxResults: pageSize,
        pageToken,
        autoPaginate: false,
      });

      const data: FileInfo[] = [];

      // Directories (prefixes from API response)
      const prefixes = (apiResponse as { prefixes?: string[] })?.prefixes;
      if (prefixes) {
        for (const dirPrefix of prefixes) {
          const userPath = fromGCSPath(dirPrefix, this.prefix);
          if (!userPath) continue;
          const name = userPath.split('/').filter(Boolean).pop() ?? userPath;
          data.push({
            name,
            path: userPath,
            size: 0,
            lastModified: new Date(0),
            isDirectory: true,
          });
        }
      }

      // Files
      for (const file of files) {
        // Skip the prefix itself
        if (file.name === gcsPrefix) continue;
        const userPath = fromGCSPath(file.name, this.prefix);
        if (!userPath) continue;
        const name = userPath.split('/').filter(Boolean).pop() ?? userPath;
        const metadata = file.metadata;
        data.push({
          name,
          path: userPath,
          size: metadata.size ? Number(metadata.size) : 0,
          lastModified: metadata.updated ? new Date(metadata.updated as string) : new Date(0),
          contentType: metadata.contentType as string | undefined,
          isDirectory: false,
        });
      }

      const nextPageToken = (queryResponse as { pageToken?: string })?.pageToken;
      const hasMore = !!nextPageToken;
      const nextCursor = hasMore ? encodeCursor({ token: nextPageToken }) : undefined;

      return { data, nextCursor, hasMore };
    } catch (err) {
      wrapError(err, 'Failed to list files');
    }
  }

  async peek(path: string, options?: PeekOptions): Promise<PeekResult> {
    this.ensureConnected();

    const gcsPath = toGCSPath(path, this.prefix);
    let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
    if (rows < 1) rows = 1;
    if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;

    const format = getFileFormat(path);
    if (!format) {
      throw new QueryError(
        `Unsupported file format for peek: "${path}". Supported: .csv, .json, .jsonl, .ndjson`,
        { code: 'VENOMOUS_UNSUPPORTED_FORMAT', connector: CONNECTOR_NAME }
      );
    }

    const file = this.bucketHandle!.file(gcsPath);

    // Pre-check file size via metadata
    try {
      const [metadata] = await file.getMetadata();
      const contentLength = metadata.size ? Number(metadata.size) : 0;
      if (contentLength > PEEK_MAX_BYTES) {
        throw new QueryError(
          `File too large for peek (${Math.round(contentLength / 1024 / 1024)}MB, limit: ${PEEK_MAX_BYTES / 1024 / 1024}MB). Use read() for streaming.`,
          { code: 'VENOMOUS_FILE_TOO_LARGE', connector: CONNECTOR_NAME }
        );
      }
    } catch (err) {
      if (err instanceof QueryError) throw err;
      wrapError(err, `Failed to check file size: "${path}"`);
    }

    // Download the file content
    let content: string;
    try {
      const [buffer] = await file.download();
      content = buffer.toString('utf-8');
    } catch (err) {
      if (err instanceof QueryError || err instanceof NotFoundError) throw err;
      wrapError(err, `Failed to read file: "${path}"`);
    }

    // Parse based on format
    if (format === 'csv') {
      const result = parseCsv(content, rows);
      return {
        data: result.data,
        columns: result.columns.length > 0 ? result.columns : undefined,
      };
    }

    // JSON or JSONL -- do not propagate parse errors as cause to avoid content leakage
    try {
      const result = parseJson(content, rows);

      // Derive columns from first row
      let columns: ColumnInfo[] | undefined;
      if (result.data.length > 0) {
        const firstRow = result.data[0]!;
        columns = Object.keys(firstRow).map((key) => ({
          name: key,
          type:
            typeof firstRow[key] === 'number'
              ? 'number'
              : typeof firstRow[key] === 'boolean'
                ? 'boolean'
                : 'string',
          nullable: true,
        }));
      }

      return { data: result.data, columns };
    } catch (err) {
      if (err instanceof QueryError) throw err;
      throw new QueryError(
        `Failed to parse ${format.toUpperCase()} file: "${path}". Check file format and content.`,
        { connector: CONNECTOR_NAME }
      );
    }
  }

  async read(path: string): Promise<ReadableStream<Uint8Array>> {
    this.ensureConnected();

    const gcsPath = toGCSPath(path, this.prefix);
    const { controller } = this.trackStream();
    const file = this.bucketHandle!.file(gcsPath);

    try {
      // Verify file exists before creating stream
      const [exists] = await file.exists();
      if (!exists) {
        this.untrackStream(controller);
        throw new NotFoundError(`File not found: "${path}"`, {
          connector: CONNECTOR_NAME,
        });
      }

      // GCS createReadStream returns a Node.js Readable.
      // Convert to Web ReadableStream using pull() mode for proper backpressure.
      const nodeStream = file.createReadStream();

      // Link AbortController to the underlying Node.js stream so that
      // disconnect() -> controller.abort() actually destroys the HTTP stream.
      controller.signal.addEventListener(
        'abort',
        () => {
          nodeStream.destroy();
        },
        { once: true }
      );

      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      const reader = webStream.getReader();
      const untrack = () => this.untrackStream(controller);

      return new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              untrack();
              ctrl.close();
            } else {
              ctrl.enqueue(value);
            }
          } catch (err) {
            untrack();
            ctrl.error(err);
          }
        },
        cancel() {
          reader.cancel();
          untrack();
        },
      });
    } catch (err) {
      this.untrackStream(controller);
      if (err instanceof NotFoundError) throw err;
      wrapError(err, `Failed to read file: "${path}"`);
    }
  }

  async stat(path: string): Promise<FileInfo> {
    this.ensureConnected();

    const gcsPath = toGCSPath(path, this.prefix);
    const file = this.bucketHandle!.file(gcsPath);
    const userPath = path;
    const name = userPath.split('/').pop() ?? userPath;

    try {
      const [metadata] = await file.getMetadata();

      return {
        name,
        path: userPath,
        size: metadata.size ? Number(metadata.size) : 0,
        lastModified: metadata.updated ? new Date(metadata.updated as string) : new Date(0),
        contentType: metadata.contentType as string | undefined,
        isDirectory: false,
      };
    } catch (err) {
      wrapError(err, `Failed to get file info: "${path}"`);
    }
  }

  async write(
    path: string,
    data: ReadableStream<Uint8Array> | Buffer | string
  ): Promise<WriteResult> {
    this.ensureConnected();

    const gcsPath = toGCSPath(path, this.prefix);
    const file = this.bucketHandle!.file(gcsPath);

    try {
      if (data instanceof ReadableStream) {
        // Convert Web ReadableStream to Node.js Readable for GCS SDK.
        // Use pipeline() instead of pipe() to ensure proper error propagation
        // and automatic cleanup of all streams when any side errors.
        const nodeStream = Readable.fromWeb(data as import('node:stream/web').ReadableStream);
        const writeStream = file.createWriteStream();
        await pipeline(nodeStream, writeStream);

        // For stream input, get size from metadata
        const [metadata] = await file.getMetadata();
        return { path, size: metadata.size ? Number(metadata.size) : 0 };
      }

      // For string and Buffer, use file.save() and calculate size locally
      await file.save(data);

      let size: number;
      if (typeof data === 'string') {
        size = Buffer.byteLength(data, 'utf-8');
      } else {
        size = data.length;
      }

      return { path, size };
    } catch (err) {
      wrapError(err, `Failed to write file: "${path}"`);
    }
  }

  async remove(path: string): Promise<void> {
    this.ensureConnected();

    const gcsPath = toGCSPath(path, this.prefix);
    const file = this.bucketHandle!.file(gcsPath);

    try {
      await file.delete();
    } catch (err) {
      // GCS throws 404 when deleting non-existent files.
      // Catch and ignore to maintain idempotent behavior (consistent with S3).
      if (err instanceof Error && (err as { code?: number }).code === 404) {
        return;
      }
      wrapError(err, `Failed to delete file: "${path}"`);
    }
  }
}
