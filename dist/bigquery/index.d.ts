import * as ___core_index_js0 from "../core/index.js";
import { BigQueryAuth, BigQueryAuth as BigQueryAuth$1, DeleteResult, FindOptions, InsertResult, PageResult, PeekOptions, PeekResult, Row, TableInfo, TabularConnector, UpdateOptions, UpdateResult, WhereOptions } from "../core/index.js";

//#region src/bigquery/types.d.ts
/**
* BigQuery connector connection options.
*/
/**
 * BigQuery connector connection options.
 */
interface BigQueryOptions {
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
interface ProjectInfo {
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
interface DatasetInfo {
  /** Dataset ID (e.g., 'my_dataset'). */
  readonly datasetId: string;
  /** Geographic location of the dataset (e.g., 'US', 'asia-northeast1'). */
  readonly location?: string;
}
/**
 * Result of a BigQuery dry-run query.
 * Contains estimated scan size and result schema without executing the query.
 */
interface DryRunResult {
  /** Estimated bytes that would be scanned by the query. */
  readonly totalBytesProcessed: number;
  /** Result schema (column names and types). */
  readonly schema: ___core_index_js0.ColumnInfo[];
} //#endregion
//#region src/bigquery/connector.d.ts

//# sourceMappingURL=types.d.ts.map
/**
 * BigQueryConnector implements TabularConnector for Google BigQuery.
 *
 * Supports two connection modes:
 * - **Traditional**: Pass `projectId` and `datasetId` in constructor options for immediate use.
 * - **Exploration**: Omit `projectId`/`datasetId`, connect with auth credentials,
 *   then use `projects()`, `datasets()`, and `useDataset()` to discover and select resources.
 *
 * @example
 * ```typescript
 * import { createBigQueryConnector } from 'venomous-datasource/bigquery';
 *
 * // Traditional usage
 * const connector = createBigQueryConnector({
 *   projectId: 'my-project',
 *   datasetId: 'my_dataset',
 * });
 * await connector.connect({ credentials: {...} });
 * const tables = await connector.tables();
 *
 * // Exploration usage (discover projects + datasets)
 * const explorer = createBigQueryConnector();
 * await explorer.connect({ credentials: {...} });
 * const datasets = await explorer.datasets();
 * await explorer.useDataset('my_dataset');
 * const tables2 = await explorer.tables();
 *
 * await connector.disconnect();
 * ```
 */
declare class BigQueryConnector implements TabularConnector<BigQueryAuth$1> {
  private readonly options;
  private projectId;
  private datasetId;
  private client;
  private dataset;
  private connected;
  private authOptions;
  /** Cached table metadata (schema + row count) per table. */
  private schemaCache;
  constructor(options?: BigQueryOptions);
  /**
   * Ensure the connector is in a base connected state (has client and projectId).
   * @throws {ConnectionError} if not connected.
   */
  private ensureConnected;
  /**
   * Ensure the connector is fully connected with a selected dataset.
   * @throws {ConnectionError} if not connected or no dataset selected.
   */
  private ensureDatasetReady;
  /**
   * Get or populate the metadata cache for a table.
   * Returns cached columns and numRows, fetching metadata only once.
   */
  private getTableMetadata;
  /**
   * Extract column names from cached schema for validation.
   */
  private getColumnNames;
  /**
   * Connect to BigQuery, initializing the client.
   *
   * BigQuery requires explicit authentication — `auth` must be provided.
   * If `projectId` was not provided in constructor options, it will be inferred from
   * the credentials object's `project_id` field.
   *
   * Calling `connect()` on an already-connected instance will disconnect first (idempotent).
   *
   * @param auth - Auth configuration. `type` can be omitted (defaults to `'credentials'`).
   * @throws {AuthenticationError} if auth is not provided or credentials are invalid.
   * @throws {ConnectionError} if connection fails or projectId cannot be determined.
   */
  connect(auth?: BigQueryAuth$1): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Switch to a different dataset. Subsequent `tables()`, `peek()`, `find()`, etc.
   * will operate on the new dataset.
   *
   * Clears the schema cache since table metadata belongs to the previous dataset.
   *
   * @param datasetId - The dataset ID to switch to.
   * @throws {ConnectionError} if not connected.
   * @throws {QueryError} if datasetId is empty.
   *
   * @example
   * ```typescript
   * const connector = createBigQueryConnector();
   * await connector.connect({ credentials: {...} });
   *
   * const datasets = await connector.datasets();
   * await connector.useDataset(datasets[0].datasetId);
   * const tables = await connector.tables();
   * ```
   */
  useDataset(datasetId: string): Promise<void>;
  /**
   * Validate a SQL query without executing it.
   *
   * Uses BigQuery's dry-run mode to check syntax, resolve schema, and estimate
   * the amount of data that would be scanned. No slot is consumed and no billing
   * is incurred.
   *
   * @param sql - The SQL query to validate.
   * @param params - Optional positional parameters (`?` placeholders).
   * @returns Estimated scan size and result schema.
   * @throws {ConnectionError} if not connected.
   * @throws {QueryError} if SQL is invalid or parameter count mismatches.
   *
   * @example
   * ```typescript
   * const result = await connector.dryRun('SELECT * FROM `project.dataset.table` WHERE id = ?', [1]);
   * console.log(result.totalBytesProcessed); // e.g. 1048576
   * console.log(result.schema); // [{ name: 'id', type: 'INTEGER', nullable: false }, ...]
   * ```
   */
  dryRun(sql: string, params?: unknown[]): Promise<DryRunResult>;
  /**
   * List BigQuery datasets in the specified project (or current project if omitted).
   *
   * If `projectId` differs from the current connection's project, a temporary
   * BigQuery client is created for the query.
   *
   * @param projectId - Target project ID. Defaults to the current project.
   * @returns Array of dataset metadata.
   * @throws {ConnectionError} if not connected.
   * @throws {PermissionError} if insufficient permissions for the target project.
   *
   * @example
   * ```typescript
   * // List datasets in current project
   * const datasets = await connector.datasets();
   *
   * // List datasets in another project
   * const otherDatasets = await connector.datasets('other-project');
   * ```
   */
  datasets(projectId?: string): Promise<DatasetInfo[]>;
  /**
   * List GCP projects accessible by the current credentials.
   *
   * Only returns projects with `ACTIVE` state. Requires the
   * `@google-cloud/resource-manager` package to be installed.
   *
   * @returns Array of project metadata (only ACTIVE projects).
   * @throws {ConnectionError} if not connected, or if `@google-cloud/resource-manager` is not installed.
   * @throws {AuthenticationError} if credentials are invalid.
   * @throws {PermissionError} if insufficient IAM permissions.
   *
   * @example
   * ```typescript
   * const connector = createBigQueryConnector();
   * await connector.connect({ credentials: {...} });
   * const projects = await connector.projects();
   * console.log(projects); // [{ projectId: 'proj-1', displayName: 'My Project', state: 'ACTIVE' }]
   * ```
   */
  projects(): Promise<ProjectInfo[]>;
  tables(): Promise<TableInfo[]>;
  peek(table: string, options?: PeekOptions): Promise<PeekResult>;
  find(table: string, options?: FindOptions): Promise<PageResult<Row>>;
  /**
   * Convert positional `?` placeholders to BigQuery named parameters (`@p0`, `@p1`, ...).
   *
   * Skips `?` characters inside single-quoted SQL string literals.
   *
   * @throws {QueryError} if placeholder count does not match params length.
   */
  private convertPositionalParams;
  sql(query: string, params?: unknown[]): AsyncIterable<Row>;
  insert(table: string, rows: Row[]): Promise<InsertResult>;
  update(table: string, options: UpdateOptions): Promise<UpdateResult>;
  remove(table: string, options: WhereOptions): Promise<DeleteResult>;
} //#endregion
//#region src/bigquery/index.d.ts

//# sourceMappingURL=connector.d.ts.map
/**
 * Create a BigQuery connector instance.
 *
 * @param options - Connection options (projectId, datasetId, location). All fields are optional.
 *   When omitted, use `connect()` with auth credentials and then `useDataset()` to select a dataset.
 * @returns An unconnected BigQueryConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createBigQueryConnector } from 'venomous-datasource/bigquery';
 *
 * // Traditional usage (projectId + datasetId)
 * const connector = createBigQueryConnector({
 *   projectId: 'my-project',
 *   datasetId: 'my_dataset',
 * });
 * await connector.connect({ credentials: {...} });
 * const tables = await connector.tables();
 * await connector.disconnect();
 *
 * // Exploration usage (no options)
 * const explorer = createBigQueryConnector();
 * await explorer.connect({ credentials: {...} });
 * const datasets = await explorer.datasets();
 * await explorer.useDataset(datasets[0].datasetId);
 * const tables2 = await explorer.tables();
 * await explorer.disconnect();
 * ```
 */
declare function createBigQueryConnector(options?: BigQueryOptions): BigQueryConnector;

//#endregion
//# sourceMappingURL=index.d.ts.map

export { BigQueryAuth, BigQueryConnector, BigQueryOptions, DatasetInfo, DryRunResult, ProjectInfo, createBigQueryConnector };
//# sourceMappingURL=index.d.ts.map