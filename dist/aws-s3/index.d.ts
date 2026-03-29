import { AWSS3Auth, AWSS3Auth as AWSS3Auth$1, FileConnector, FileInfo, ListOptions, PageResult, PeekOptions, PeekResult, WriteResult } from "../core/index.js";

//#region src/aws-s3/types.d.ts
/**
* AWS S3 connector connection options.
*/
/**
 * AWS S3 connector connection options.
 */
interface AWSS3Options {
  /** S3 bucket name. */
  readonly bucket: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /**
   * AWS region (e.g., "us-east-1", "ap-northeast-1").
   *
   * Note: This field is retained for backward compatibility but no longer affects
   * connection behavior. The `region` in `AWSS3Auth` (passed to `connect()`) is
   * used for SDK configuration.
   */
  readonly region?: string;
} //#endregion
//#region src/aws-s3/connector.d.ts

//# sourceMappingURL=types.d.ts.map

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
declare class AWSS3Connector implements FileConnector<AWSS3Auth$1> {
  private readonly bucket;
  private readonly prefix?;
  private client;
  private connected;
  /** Active stream abort controllers for resource cleanup. */
  private activeStreams;
  constructor(options: AWSS3Options);
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
  connect(auth?: AWSS3Auth$1): Promise<void>;
  disconnect(): Promise<void>;
  files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>>;
  peek(path: string, options?: PeekOptions): Promise<PeekResult>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  stat(path: string): Promise<FileInfo>;
  write(path: string, data: ReadableStream<Uint8Array> | Buffer | string): Promise<WriteResult>;
  remove(path: string): Promise<void>;
}

//#endregion
//#region src/aws-s3/index.d.ts
//# sourceMappingURL=connector.d.ts.map
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
declare function createAWSS3Connector(options: AWSS3Options): FileConnector<AWSS3Auth$1>;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { AWSS3Auth, AWSS3Connector, AWSS3Options, createAWSS3Connector };
//# sourceMappingURL=index.d.ts.map