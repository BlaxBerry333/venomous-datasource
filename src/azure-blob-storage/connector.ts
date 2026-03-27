import type { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import type {
  FileConnector,
  AzureBlobStorageAuth,
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
import { toBlobPath, fromBlobPath, toBlobPrefix } from './path.js';
import { parseCsv, parseJson, getFileFormat } from '../core/index.js';
import type { AzureBlobStorageOptions } from './types.js';
import { Readable } from 'node:stream';

const CONNECTOR_NAME = 'azure-blob-storage';
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1000;
const PEEK_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_ACTIVE_STREAMS = 10;
const DEFAULT_PAGE_SIZE = 50;
const UPLOAD_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB
const UPLOAD_MAX_CONCURRENCY = 4;

/**
 * MIME type mapping for common file extensions.
 * Azure Blob Storage does not auto-detect Content-Type, so we infer it.
 */
const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.parquet': 'application/octet-stream',
};

/**
 * Infer Content-Type from file extension.
 */
function inferContentType(path: string): string {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex === -1) return 'application/octet-stream';
  const ext = path.slice(dotIndex).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Sanitize an error cause to prevent SAS token leakage.
 *
 * Azure SDK's RestError may include the full request URL (with SAS token)
 * in its `request` property. We create a minimal cause that only preserves
 * safe diagnostic fields.
 */
function sanitizeCause(err: unknown): Error {
  if (err instanceof Error && 'statusCode' in err) {
    const restErr = err as Error & { statusCode?: number; code?: string };
    const sanitized = new Error(restErr.message);
    sanitized.name = restErr.name;
    (sanitized as Error & { statusCode?: number }).statusCode = restErr.statusCode;
    (sanitized as Error & { code?: string }).code = restErr.code;
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
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof Error) {
    const message = err.message || defaultMessage;
    const statusCode = (err as { statusCode?: number }).statusCode;
    const code = (err as { code?: string }).code;
    const cause = sanitizeCause(err);

    // Status code based mapping
    if (statusCode === 401) {
      throw new AuthenticationError(`Azure Blob authentication failed: ${message}`, {
        cause,
        connector: CONNECTOR_NAME,
      });
    }

    if (statusCode === 403) {
      throw new PermissionError(message, { cause, connector: CONNECTOR_NAME });
    }

    if (statusCode === 404) {
      throw new NotFoundError(message, { cause, connector: CONNECTOR_NAME });
    }

    // String code based mapping
    if (code === 'AuthenticationFailed' || code === 'InvalidAuthenticationInfo') {
      throw new AuthenticationError(`Azure Blob authentication failed: ${message}`, {
        cause,
        connector: CONNECTOR_NAME,
      });
    }

    if (code === 'AuthorizationFailure') {
      throw new PermissionError(message, { cause, connector: CONNECTOR_NAME });
    }

    if (code === 'ContainerNotFound' || code === 'BlobNotFound') {
      throw new NotFoundError(message, { cause, connector: CONNECTOR_NAME });
    }

    // Network errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND')
    ) {
      throw new ConnectionError(`Azure Blob connection failed: ${message}`, {
        cause,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`Azure Blob operation failed: ${message}`, {
      cause,
      connector: CONNECTOR_NAME,
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
export class AzureBlobStorageConnector implements FileConnector<AzureBlobStorageAuth> {
  private readonly container: string;
  private readonly prefix?: string;
  private blobServiceClient: BlobServiceClient | null = null;
  private containerClient: ContainerClient | null = null;
  private connected = false;

  /** Active stream abort controllers for resource cleanup. */
  private activeStreams = new Set<AbortController>();

  constructor(options: AzureBlobStorageOptions) {
    if (!options.container || options.container.trim() === '') {
      throw new ConnectionError('container is required', {
        code: 'VENOMOUS_INVALID_OPTIONS',
        connector: CONNECTOR_NAME,
      });
    }

    this.container = options.container;
    this.prefix = options.prefix;
  }

  /**
   * Ensure the connector is in a connected state.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.blobServiceClient || !this.containerClient) {
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

  async connect(auth?: AzureBlobStorageAuth): Promise<void> {
    const { client } = await resolveAuth(auth);

    this.blobServiceClient = client;
    this.containerClient = client.getContainerClient(this.container);

    // Validate connectivity by checking container existence
    try {
      await this.containerClient.getProperties();
    } catch (err) {
      this.blobServiceClient = null;
      this.containerClient = null;

      // Check for ContainerNotFound specifically
      const code = (err as { code?: string }).code;
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || code === 'ContainerNotFound') {
        throw new NotFoundError(`Container "${this.container}" does not exist`, {
          connector: CONNECTOR_NAME,
        });
      }
      wrapError(err, `Failed to connect to Azure Blob container "${this.container}"`);
    }

    // No auth reference is stored. The auth object is only used to create
    // the BlobServiceClient above.

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // Abort all active streams
    for (const controller of this.activeStreams) {
      controller.abort();
    }
    this.activeStreams.clear();

    this.blobServiceClient = null;
    this.containerClient = null;
    this.connected = false;
  }

  async files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>> {
    this.ensureConnected();

    const blobPrefix = toBlobPrefix(path, this.prefix);
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
      const iterator = this.containerClient!.listBlobsByHierarchy('/', {
        prefix: blobPrefix || undefined,
      }).byPage({ maxPageSize: pageSize, continuationToken });

      const page = await iterator.next();
      const segment = page.value;

      const data: FileInfo[] = [];

      // Directories (blob prefixes) -- may be undefined when no directories exist
      const prefixes = segment.segment.blobPrefixes;
      if (prefixes) {
        for (const dirPrefix of prefixes) {
          const userPath = fromBlobPath(dirPrefix.name, this.prefix);
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

      // Files (blob items)
      const blobItems = segment.segment.blobItems;
      if (blobItems) {
        for (const blob of blobItems) {
          // Skip the prefix itself
          if (blob.name === blobPrefix) continue;
          const userPath = fromBlobPath(blob.name, this.prefix);
          if (!userPath) continue;
          const name = userPath.split('/').filter(Boolean).pop() ?? userPath;
          data.push({
            name,
            path: userPath,
            size: blob.properties.contentLength ?? 0,
            lastModified: blob.properties.lastModified ?? new Date(0),
            contentType: blob.properties.contentType,
            isDirectory: false,
          });
        }
      }

      const nextToken = segment.continuationToken;
      const hasMore = !!nextToken;
      const nextCursor = hasMore ? encodeCursor({ token: nextToken }) : undefined;

      return { data, nextCursor, hasMore };
    } catch (err) {
      wrapError(err, 'Failed to list files');
    }
  }

  async peek(path: string, options?: PeekOptions): Promise<PeekResult> {
    this.ensureConnected();

    const blobPath = toBlobPath(path, this.prefix);
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

    const blockBlobClient = this.containerClient!.getBlockBlobClient(blobPath);

    // Pre-check file size via properties
    try {
      const properties = await blockBlobClient.getProperties();
      const contentLength = properties.contentLength ?? 0;
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
      const response = await blockBlobClient.download(0);
      const body = response.readableStreamBody;
      if (!body) {
        throw new QueryError(`Failed to read file: "${path}" (no stream body)`, {
          connector: CONNECTOR_NAME,
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      content = Buffer.concat(chunks).toString('utf-8');
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

    const blobPath = toBlobPath(path, this.prefix);
    const { controller } = this.trackStream();
    const blockBlobClient = this.containerClient!.getBlockBlobClient(blobPath);

    try {
      // Verify blob exists before creating stream
      const response = await blockBlobClient.download(0);
      const body = response.readableStreamBody;

      if (!body) {
        this.untrackStream(controller);
        throw new NotFoundError(`File not found: "${path}"`, {
          connector: CONNECTOR_NAME,
        });
      }

      // Azure SDK returns a Node.js Readable. Convert to Web ReadableStream
      // using pull() mode for proper backpressure.
      const nodeStream = body as import('node:stream').Readable;

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

      // Azure SDK throws 404 for non-existent blobs on download
      const statusCode = (err as { statusCode?: number }).statusCode;
      const code = (err as { code?: string }).code;
      if (statusCode === 404 || code === 'BlobNotFound') {
        throw new NotFoundError(`File not found: "${path}"`, {
          connector: CONNECTOR_NAME,
        });
      }
      wrapError(err, `Failed to read file: "${path}"`);
    }
  }

  async stat(path: string): Promise<FileInfo> {
    this.ensureConnected();

    const blobPath = toBlobPath(path, this.prefix);
    const blockBlobClient = this.containerClient!.getBlockBlobClient(blobPath);
    const userPath = path;
    const name = userPath.split('/').pop() ?? userPath;

    try {
      const properties = await blockBlobClient.getProperties();

      return {
        name,
        path: userPath,
        size: properties.contentLength ?? 0,
        lastModified: properties.lastModified ?? new Date(0),
        contentType: properties.contentType,
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

    const blobPath = toBlobPath(path, this.prefix);
    const blockBlobClient = this.containerClient!.getBlockBlobClient(blobPath);
    const contentType = inferContentType(path);
    const blobHTTPHeaders = { blobContentType: contentType };

    try {
      if (data instanceof ReadableStream) {
        // Convert Web ReadableStream to Node.js Readable for Azure SDK.
        const nodeStream = Readable.fromWeb(data as import('node:stream/web').ReadableStream);
        await blockBlobClient.uploadStream(nodeStream, UPLOAD_BUFFER_SIZE, UPLOAD_MAX_CONCURRENCY, {
          blobHTTPHeaders,
        });

        // For stream input, get size from properties
        const properties = await blockBlobClient.getProperties();
        return { path, size: properties.contentLength ?? 0 };
      }

      // For string and Buffer, use upload() with known length
      let body: Buffer;
      if (typeof data === 'string') {
        body = Buffer.from(data, 'utf-8');
      } else {
        body = data;
      }

      await blockBlobClient.upload(body, body.length, { blobHTTPHeaders });

      return { path, size: body.length };
    } catch (err) {
      wrapError(err, `Failed to write file: "${path}"`);
    }
  }

  async remove(path: string): Promise<void> {
    this.ensureConnected();

    const blobPath = toBlobPath(path, this.prefix);

    try {
      await this.containerClient!.deleteBlob(blobPath);
    } catch (err) {
      // Idempotent delete: 404 is silently swallowed
      const statusCode = (err as { statusCode?: number }).statusCode;
      const code = (err as { code?: string }).code;
      if (statusCode === 404 || code === 'BlobNotFound') {
        return;
      }
      wrapError(err, `Failed to delete file: "${path}"`);
    }
  }
}
