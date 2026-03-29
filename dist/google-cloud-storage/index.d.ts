import { FileConnector, FileInfo, GoogleCloudStorageAuth, GoogleCloudStorageAuth as GoogleCloudStorageAuth$1, ListOptions, PageResult, PeekOptions, PeekResult, WriteResult } from "../core/index.js";

//#region src/google-cloud-storage/types.d.ts
/**
* Google Cloud Storage connector connection options.
*/
/**
 * Google Cloud Storage connector connection options.
 */
interface GoogleCloudStorageOptions {
  /** Google Cloud Storage bucket name. */
  readonly bucket: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /** GCP project ID (optional, overrides project_id in service account credentials). */
  readonly projectId?: string;
} //#endregion
//#region src/google-cloud-storage/connector.d.ts

//# sourceMappingURL=types.d.ts.map

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
declare class GoogleCloudStorageConnector implements FileConnector<GoogleCloudStorageAuth$1> {
  private readonly bucket;
  private readonly prefix?;
  private readonly projectId?;
  private storage;
  private bucketHandle;
  private connected;
  /** Active stream abort controllers for resource cleanup. */
  private activeStreams;
  constructor(options: GoogleCloudStorageOptions);
  /**
   * Ensure the connector is in a connected state.
   */
  private ensureConnected;
  /**
   * Track an active stream and return its AbortController signal.
   * Enforces the MAX_ACTIVE_STREAMS limit.
   */
  private trackStream;
  /**
   * Untrack a stream after it's closed.
   */
  private untrackStream;
  connect(auth?: GoogleCloudStorageAuth$1): Promise<void>;
  disconnect(): Promise<void>;
  files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>>;
  peek(path: string, options?: PeekOptions): Promise<PeekResult>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  stat(path: string): Promise<FileInfo>;
  write(path: string, data: ReadableStream<Uint8Array> | Buffer | string): Promise<WriteResult>;
  remove(path: string): Promise<void>;
}

//#endregion
//#region src/google-cloud-storage/index.d.ts
//# sourceMappingURL=connector.d.ts.map
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
declare function createGoogleCloudStorageConnector(options: GoogleCloudStorageOptions): FileConnector<GoogleCloudStorageAuth$1>;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { GoogleCloudStorageAuth, GoogleCloudStorageConnector, GoogleCloudStorageOptions, createGoogleCloudStorageConnector };
//# sourceMappingURL=index.d.ts.map