/**
 * AWS S3 connector connection options.
 */
export interface AWSS3Options {
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
}
