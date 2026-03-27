/**
 * Google Cloud Storage connector connection options.
 */
export interface GoogleCloudStorageOptions {
  /** Google Cloud Storage bucket name. */
  readonly bucket: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /** GCP project ID (optional, overrides project_id in service account credentials). */
  readonly projectId?: string;
}
