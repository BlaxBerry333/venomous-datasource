/**
 * BigQuery connector connection options.
 */
export interface BigQueryOptions {
  /** Google Cloud project ID. If omitted, inferred from auth credentials. */
  readonly projectId?: string;
  /** BigQuery dataset ID to operate on. If omitted, call useDataset() after connect(). */
  readonly datasetId?: string;
  /** BigQuery data location (e.g., 'US', 'asia-northeast1'). */
  readonly location?: string;
}

/**
 * GCP project metadata returned by BigQueryConnector.projects().
 */
export interface ProjectInfo {
  /** GCP project ID (e.g., 'my-project-123'). */
  readonly projectId: string;
  /** Display name of the project. */
  readonly displayName: string;
  /** Project state ('ACTIVE', 'DELETE_REQUESTED', etc.). */
  readonly state: string;
}

/**
 * BigQuery dataset metadata returned by BigQueryConnector.datasets().
 */
export interface DatasetInfo {
  /** Dataset ID (e.g., 'my_dataset'). */
  readonly datasetId: string;
  /** Geographic location of the dataset (e.g., 'US', 'asia-northeast1'). */
  readonly location?: string;
}

/**
 * Result of a BigQuery dry-run query.
 * Contains estimated scan size and result schema without executing the query.
 */
export interface DryRunResult {
  /** Estimated bytes that would be scanned by the query. */
  readonly totalBytesProcessed: number;
  /** Result schema (column names and types). */
  readonly schema: import('../core/index.js').ColumnInfo[];
}
