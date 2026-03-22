/**
 * GCS connector connection options.
 */
export interface GCSOptions {
  /** GCS bucket name. */
  readonly bucket: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /** GCP project ID (optional, SDK infers from ADC or service account). */
  readonly projectId?: string;
}
