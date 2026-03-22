/**
 * S3 connector connection options.
 */
export interface S3Options {
  /** S3 bucket name. */
  readonly bucket: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /** AWS region (e.g., "us-east-1", "ap-northeast-1"). */
  readonly region?: string;
}
