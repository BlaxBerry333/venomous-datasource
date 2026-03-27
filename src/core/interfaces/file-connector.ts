import type { FileAuth } from '../types/auth.js';
import type { PageResult } from '../types/pagination.js';
import type { ListOptions, PeekOptions } from '../types/query.js';
import type { FileInfo, PeekResult, WriteResult } from '../types/result.js';

/**
 * Interface for file-based data source connectors.
 *
 * Implementations: AWS S3, Google Cloud Storage, Azure Blob Storage.
 *
 * @typeParam TAuth - Authentication type, must extend FileAuth.
 *
 * @example
 * ```typescript
 * const connector: FileConnector<AWSS3Auth> = createAWSS3Connector({ bucket: 'my-bucket' });
 * await connector.connect({ accessKeyId: '...', secretAccessKey: '...', region: 'us-east-1' });
 * const fileList = await connector.files('data/', { page: { size: 20 } });
 * const stream = await connector.read('data/report.csv');
 * await connector.disconnect();
 * ```
 */
export interface FileConnector<TAuth extends FileAuth = FileAuth> {
  /**
   * Connect to the storage service and initialize the client.
   * Some connectors (e.g., Google Sheets, Firestore, MongoDB) default to
   * `{ type: 'auto' }` when no auth is provided. Others (AWS S3, Google Cloud
   * Storage, Azure Blob Storage) require explicit auth and will throw
   * `AuthenticationError` if auth is not provided.
   *
   * @param auth - Authentication configuration.
   * @throws {AuthenticationError} When credentials are invalid.
   * @throws {ConnectionError} When the storage service is unreachable.
   */
  connect(auth?: TAuth): Promise<void>;

  /**
   * Disconnect and release all resources.
   */
  disconnect(): Promise<void>;

  /**
   * List files in a directory with pagination.
   *
   * @param path - Directory path (relative to bucket/container root). Defaults to root.
   * @param options - Listing options with pagination.
   * @returns Paginated list of file metadata.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>>;

  /**
   * Preview the content of a file (CSV/JSON first N rows).
   *
   * @param path - File path relative to bucket/container root.
   * @param options - Preview options (default: 10 rows).
   * @returns Preview result with data and optional column metadata.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  peek(path: string, options?: PeekOptions): Promise<PeekResult>;

  /**
   * Read a file and return its content as a ReadableStream.
   *
   * @param path - File path relative to bucket/container root.
   * @returns ReadableStream of file content.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  read(path: string): Promise<ReadableStream<Uint8Array>>;

  /**
   * Get file metadata.
   *
   * @param path - File path relative to bucket/container root.
   * @returns File metadata.
   * @throws {NotFoundError} When the file does not exist.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  stat(path: string): Promise<FileInfo>;

  /**
   * Write data to a file (optional capability).
   *
   * @param path - File path relative to bucket/container root.
   * @param data - Data to write.
   * @returns Write result with path and size.
   * @throws {PermissionError} When write access is denied.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  write?(path: string, data: ReadableStream<Uint8Array> | Buffer | string): Promise<WriteResult>;

  /**
   * Delete a file (optional capability).
   *
   * Idempotent: deleting a non-existent file succeeds silently.
   *
   * @param path - File path relative to bucket/container root.
   * @throws {PermissionError} When write access is denied.
   * @throws {PathError} When the path is invalid or unsafe.
   */
  remove?(path: string): Promise<void>;
}
