import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import type {
  FileConnector,
  S3Auth,
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
import { toS3Key, fromS3Key, toS3Prefix } from './path.js';
import { parseCsv, parseJson, getFileFormat } from '../core/index.js';
import type { S3Options } from './types.js';
import { Readable } from 'node:stream';

const CONNECTOR_NAME = 's3';
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1000;
const PEEK_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Map S3 SDK errors to appropriate VenomousError subclasses.
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof Error) {
    const message = err.message || defaultMessage;
    const errName = err.name;

    // S3 SDK v3 uses error name for classification
    if (errName === 'NoSuchBucket' || errName === 'NotFound' || errName === 'NoSuchKey') {
      throw new NotFoundError(message, { cause: err, connector: CONNECTOR_NAME });
    }

    if (errName === 'AccessDenied' || errName === 'Forbidden') {
      throw new PermissionError(message, { cause: err, connector: CONNECTOR_NAME });
    }

    if (
      errName === 'InvalidAccessKeyId' ||
      errName === 'SignatureDoesNotMatch' ||
      errName === 'ExpiredToken' ||
      errName === 'InvalidToken' ||
      errName === 'CredentialsProviderError'
    ) {
      throw new AuthenticationError(`S3 authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // HTTP status code based classification
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (statusCode === 401) {
      throw new AuthenticationError(`S3 authentication failed: ${message}`, {
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

    // Network errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('NetworkingError') ||
      errName === 'NetworkingError'
    ) {
      throw new ConnectionError(`S3 connection failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`S3 operation failed: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}

/**
 * S3Connector implements FileConnector for Amazon S3.
 *
 * @example
 * ```typescript
 * import { createS3Connector } from 'venomous-datasource/s3';
 *
 * const connector = createS3Connector({ bucket: 'my-bucket', prefix: 'data/' });
 * await connector.connect(); // uses default credential chain
 * const files = await connector.files('reports/');
 * const preview = await connector.peek('reports/sales.csv', { rows: 5 });
 * const stream = await connector.read('reports/sales.csv');
 * await connector.disconnect();
 * ```
 */
export class S3Connector implements FileConnector<S3Auth> {
  private readonly bucket: string;
  private readonly prefix?: string;
  private readonly defaultRegion?: string;
  private client: S3Client | null = null;
  private connected = false;

  /** Active stream abort controllers for resource cleanup. */
  private activeStreams = new Set<AbortController>();

  constructor(options: S3Options) {
    if (!options.bucket || options.bucket.trim() === '') {
      throw new ConnectionError('bucket is required', {
        code: 'VENOMOUS_INVALID_OPTIONS',
        connector: CONNECTOR_NAME,
      });
    }

    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.defaultRegion = options.region;
  }

  /**
   * Ensure the connector is in a connected state.
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

  async connect(auth?: S3Auth): Promise<void> {
    const sdkConfig: S3ClientConfig = {
      ...resolveAuth(auth, this.defaultRegion),
    };

    this.client = new S3Client(sdkConfig);

    // Validate connectivity by checking bucket access
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      this.client.destroy();
      this.client = null;
      wrapError(err, `Failed to connect to S3 bucket "${this.bucket}"`);
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // Abort all active streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    this.connected = false;
  }

  async files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>> {
    this.ensureConnected();

    const s3Prefix = toS3Prefix(path, this.prefix);
    const pageSize = options?.page?.size
      ? validatePageSize(options.page.size).value
      : DEFAULT_PAGE_SIZE;

    let continuationToken: string | undefined;
    if (options?.page?.cursor) {
      const state = decodeCursor(options.page.cursor);
      if (typeof state['token'] !== 'string') {
        throw new QueryError('Invalid cursor: missing token', {
          code: 'VENOMOUS_INVALID_CURSOR',
          connector: CONNECTOR_NAME,
        });
      }
      continuationToken = state['token'] as string;
    }

    try {
      const response = await this.client!.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: s3Prefix || undefined,
          Delimiter: '/',
          MaxKeys: pageSize,
          ContinuationToken: continuationToken,
        })
      );

      const data: FileInfo[] = [];

      // Directories (CommonPrefixes)
      if (response.CommonPrefixes) {
        for (const prefix of response.CommonPrefixes) {
          if (!prefix.Prefix) continue;
          const userPath = fromS3Key(prefix.Prefix, this.prefix);
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

      // Files (Contents)
      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;
          // Skip the prefix itself (S3 sometimes returns the prefix as a key)
          if (obj.Key === s3Prefix) continue;
          const userPath = fromS3Key(obj.Key, this.prefix);
          if (!userPath) continue;
          const name = userPath.split('/').pop() ?? userPath;
          data.push({
            name,
            path: userPath,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified ?? new Date(0),
            contentType: undefined,
            isDirectory: false,
          });
        }
      }

      const hasMore = response.IsTruncated ?? false;
      const nextCursor =
        hasMore && response.NextContinuationToken
          ? encodeCursor({ token: response.NextContinuationToken })
          : undefined;

      return { data, nextCursor, hasMore };
    } catch (err) {
      wrapError(err, 'Failed to list files');
    }
  }

  async peek(path: string, options?: PeekOptions): Promise<PeekResult> {
    this.ensureConnected();

    const s3Key = toS3Key(path, this.prefix);
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

    // Pre-check file size via HeadObject
    try {
      const headResponse = await this.client!.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key })
      );

      const contentLength = headResponse.ContentLength ?? 0;
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
      const response = await this.client!.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: s3Key })
      );

      if (!response.Body) {
        throw new NotFoundError(`File body is empty: "${path}"`, {
          connector: CONNECTOR_NAME,
        });
      }

      content = await response.Body.transformToString('utf-8');
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

    // JSON or JSONL
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

    const s3Key = toS3Key(path, this.prefix);
    const { controller } = this.trackStream();

    try {
      const response = await this.client!.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
        }),
        { abortSignal: controller.signal }
      );

      if (!response.Body) {
        this.untrackStream(controller);
        throw new NotFoundError(`File body is empty: "${path}"`, {
          connector: CONNECTOR_NAME,
        });
      }

      // Convert SDK stream to Web ReadableStream with stream tracking for resource cleanup.
      // Uses pull() instead of start() to respect backpressure from the consumer.
      const sdkWebStream =
        response.Body.transformToWebStream() as unknown as ReadableStream<Uint8Array>;
      const reader = sdkWebStream.getReader();
      const self = this;

      return new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              self.untrackStream(controller);
              ctrl.close();
            } else {
              ctrl.enqueue(value);
            }
          } catch (err) {
            self.untrackStream(controller);
            ctrl.error(err);
          }
        },
        cancel() {
          reader.cancel();
          self.untrackStream(controller);
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

    const s3Key = toS3Key(path, this.prefix);
    const userPath = path;
    const name = userPath.split('/').pop() ?? userPath;

    try {
      const response = await this.client!.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key })
      );

      return {
        name,
        path: userPath,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified ?? new Date(0),
        contentType: response.ContentType,
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

    const s3Key = toS3Key(path, this.prefix);

    // Convert input to a type the SDK accepts
    let body: Readable | Buffer | string;
    if (data instanceof ReadableStream) {
      body = Readable.fromWeb(data as import('node:stream/web').ReadableStream);
    } else {
      body = data;
    }

    try {
      await this.client!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: body,
        })
      );

      // Calculate size locally for string/Buffer; only use HeadObject for streams
      let size: number;
      if (typeof data === 'string') {
        size = Buffer.byteLength(data, 'utf-8');
      } else if (Buffer.isBuffer(data)) {
        size = data.length;
      } else {
        const headResponse = await this.client!.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key })
        );
        size = headResponse.ContentLength ?? 0;
      }

      return { path, size };
    } catch (err) {
      wrapError(err, `Failed to write file: "${path}"`);
    }
  }

  async remove(path: string): Promise<void> {
    this.ensureConnected();

    const s3Key = toS3Key(path, this.prefix);

    try {
      // S3 DeleteObject is idempotent -- does not throw for non-existent keys
      await this.client!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key }));
    } catch (err) {
      wrapError(err, `Failed to delete file: "${path}"`);
    }
  }
}
