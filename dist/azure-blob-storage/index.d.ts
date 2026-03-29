import { AzureBlobStorageAuth, AzureBlobStorageAuth as AzureBlobStorageAuth$1, FileConnector, FileInfo, ListOptions, PageResult, PeekOptions, PeekResult, WriteResult } from "../core/index.js";

//#region src/azure-blob-storage/types.d.ts
/**
* Azure Blob Storage connector connection options.
*/
/**
 * Azure Blob Storage connector connection options.
 */
interface AzureBlobStorageOptions {
  /** Azure Blob container name. */
  readonly container: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /**
   * Azure Storage account name.
   * Required for `sas-token` auth mode.
   * For `connection-string` mode, the account name is extracted from the connection string.
   */
  readonly accountName?: string;
} //#endregion
//#region src/azure-blob-storage/connector.d.ts

//# sourceMappingURL=types.d.ts.map

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
declare class AzureBlobStorageConnector implements FileConnector<AzureBlobStorageAuth$1> {
  private readonly container;
  private readonly prefix?;
  private blobServiceClient;
  private containerClient;
  private connected;
  /** Active stream abort controllers for resource cleanup. */
  private activeStreams;
  constructor(options: AzureBlobStorageOptions);
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
  connect(auth?: AzureBlobStorageAuth$1): Promise<void>;
  disconnect(): Promise<void>;
  files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>>;
  peek(path: string, options?: PeekOptions): Promise<PeekResult>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  stat(path: string): Promise<FileInfo>;
  write(path: string, data: ReadableStream<Uint8Array> | Buffer | string): Promise<WriteResult>;
  remove(path: string): Promise<void>;
}

//#endregion
//#region src/azure-blob-storage/index.d.ts
//# sourceMappingURL=connector.d.ts.map
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
declare function createAzureBlobStorageConnector(options: AzureBlobStorageOptions): FileConnector<AzureBlobStorageAuth$1>;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { AzureBlobStorageAuth, AzureBlobStorageConnector, AzureBlobStorageOptions, createAzureBlobStorageConnector };
//# sourceMappingURL=index.d.ts.map