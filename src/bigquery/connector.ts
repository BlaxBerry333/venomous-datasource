import { BigQuery, type Dataset } from '@google-cloud/bigquery';
import type {
  TabularConnector,
  BigQueryAuth,
  TableInfo,
  ColumnInfo,
  PeekResult,
  PeekOptions,
  FindOptions,
  UpdateOptions,
  WhereOptions,
  Row,
  PageResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  WhereClause,
  WhereCondition,
  OrderByClause,
} from '../core/index.js';
import {
  ConnectionError,
  AuthenticationError,
  PermissionError,
  QueryError,
  NotFoundError,
  validatePageSize,
  encodeCursor,
  decodeCursor,
} from '../core/index.js';
import { resolveAuth, resolveProjectId } from './auth.js';
import type { BigQueryOptions, ProjectInfo, DatasetInfo } from './types.js';

const CONNECTOR_NAME = 'bigquery';
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1000;
const DEFAULT_PAGE_SIZE = 50;

/** Regex pattern for valid BigQuery identifiers (table/column names). */
const VALID_IDENTIFIER = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that a string is a safe BigQuery identifier.
 * Prevents SQL injection through table/column names.
 */
function validateIdentifier(name: string, label: string): void {
  if (!name || !VALID_IDENTIFIER.test(name)) {
    throw new QueryError(
      `Invalid ${label}: "${name}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
      { code: 'VENOMOUS_INVALID_IDENTIFIER', connector: CONNECTOR_NAME }
    );
  }
}

/**
 * Escape a BigQuery identifier with backticks.
 */
function escapeIdentifier(name: string): string {
  return `\`${name}\``;
}

/**
 * Map BigQuery SDK errors to appropriate VenomousError subclasses.
 */
function wrapError(err: unknown, defaultMessage: string): never {
  if (err instanceof Error) {
    const message = err.message || defaultMessage;
    const errCode = (err as { code?: number | string }).code;

    // Classify by HTTP status code first (most reliable)
    if (errCode === 401) {
      throw new AuthenticationError(`BigQuery authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errCode === 403) {
      throw new PermissionError(`BigQuery permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    if (errCode === 404) {
      throw new NotFoundError(message, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Fall back to message-based classification with precise patterns
    // Authentication errors
    if (
      message.includes('Could not load the default credentials') ||
      message.includes('invalid_grant') ||
      message.includes('UNAUTHENTICATED') ||
      message.includes('credentials are required') ||
      message.includes('credentials are not valid')
    ) {
      throw new AuthenticationError(`BigQuery authentication failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Permission errors (gRPC)
    if (message.includes('PERMISSION_DENIED')) {
      throw new PermissionError(`BigQuery permission denied: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Not found errors
    if (message.includes('Not found') || message.includes('notFound')) {
      throw new NotFoundError(message, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Connection errors
    if (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('network error') ||
      message.includes('Network Error')
    ) {
      throw new ConnectionError(`BigQuery connection failed: ${message}`, {
        cause: err,
        connector: CONNECTOR_NAME,
      });
    }

    // Default to QueryError
    throw new QueryError(`BigQuery query failed: ${message}`, {
      cause: err,
      connector: CONNECTOR_NAME,
    });
  }

  throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}

/**
 * Build a parameterized WHERE clause from a WhereClause array.
 *
 * @returns Object with `sql` string and `params` record for BigQuery named params.
 */
function buildWhereClause(
  where: WhereClause,
  knownColumns: Set<string>
): { sql: string; params: Record<string, unknown> } {
  if (where.length === 0) {
    return { sql: '', params: {} };
  }

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  for (let i = 0; i < where.length; i++) {
    const condition = where[i] as WhereCondition;
    validateIdentifier(condition.field, 'column name');

    if (knownColumns.size > 0 && !knownColumns.has(condition.field)) {
      throw new QueryError(
        `Unknown column: "${condition.field}". Known columns: ${[...knownColumns].join(', ')}`,
        { code: 'VENOMOUS_UNKNOWN_COLUMN', connector: CONNECTOR_NAME }
      );
    }

    const col = escapeIdentifier(condition.field);
    const paramName = `p${i}`;

    switch (condition.operator) {
      case 'eq':
        if (condition.value === null) {
          conditions.push(`${col} IS NULL`);
        } else {
          conditions.push(`${col} = @${paramName}`);
          params[paramName] = condition.value;
        }
        break;
      case 'ne':
        if (condition.value === null) {
          conditions.push(`${col} IS NOT NULL`);
        } else {
          conditions.push(`${col} != @${paramName}`);
          params[paramName] = condition.value;
        }
        break;
      case 'gt':
        conditions.push(`${col} > @${paramName}`);
        params[paramName] = condition.value;
        break;
      case 'lt':
        conditions.push(`${col} < @${paramName}`);
        params[paramName] = condition.value;
        break;
      case 'gte':
        conditions.push(`${col} >= @${paramName}`);
        params[paramName] = condition.value;
        break;
      case 'lte':
        conditions.push(`${col} <= @${paramName}`);
        params[paramName] = condition.value;
        break;
      case 'in':
        conditions.push(`${col} IN UNNEST(@${paramName})`);
        params[paramName] = condition.value;
        break;
      case 'like':
        conditions.push(`${col} LIKE @${paramName}`);
        params[paramName] = condition.value;
        break;
      default: {
        const _exhaustive: never = condition.operator;
        throw new QueryError(`Unsupported operator: "${String(_exhaustive)}"`, {
          code: 'VENOMOUS_UNSUPPORTED_OPERATOR',
          connector: CONNECTOR_NAME,
        });
      }
    }
  }

  return { sql: `WHERE ${conditions.join(' AND ')}`, params };
}

/**
 * Build an ORDER BY clause from OrderByClause array.
 */
function buildOrderByClause(orderBy: OrderByClause[], knownColumns: Set<string>): string {
  if (orderBy.length === 0) {
    return '';
  }

  const parts: string[] = [];
  for (const clause of orderBy) {
    validateIdentifier(clause.field, 'column name');

    if (knownColumns.size > 0 && !knownColumns.has(clause.field)) {
      throw new QueryError(`Unknown column in ORDER BY: "${clause.field}"`, {
        code: 'VENOMOUS_UNKNOWN_COLUMN',
        connector: CONNECTOR_NAME,
      });
    }

    parts.push(`${escapeIdentifier(clause.field)} ${clause.direction === 'desc' ? 'DESC' : 'ASC'}`);
  }

  return `ORDER BY ${parts.join(', ')}`;
}

/**
 * Map BigQuery schema fields to ColumnInfo array.
 */
function mapSchemaFields(
  schema:
    | { fields?: Array<{ name: string; type: string; mode?: string; description?: string }> }
    | undefined
): ColumnInfo[] {
  if (!schema?.fields) {
    return [];
  }
  return schema.fields.map((field) => ({
    name: field.name,
    type: field.type,
    nullable: field.mode !== 'REQUIRED',
    description: field.description || undefined,
  }));
}

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
 * await connector.connect();
 * const tables = await connector.tables();
 *
 * // Exploration usage
 * const explorer = createBigQueryConnector();
 * await explorer.connect({ type: 'service-account', keyFilePath: '/path/to/key.json' });
 * const datasets = await explorer.datasets();
 * explorer.useDataset('my_dataset');
 * const tables2 = await explorer.tables();
 *
 * await connector.disconnect();
 * ```
 */
export class BigQueryConnector implements TabularConnector<BigQueryAuth> {
  private readonly options: BigQueryOptions;
  private projectId: string | undefined;
  private datasetId: string | undefined;
  private client: BigQuery | null = null;
  private dataset: Dataset | null = null;
  private connected = false;
  private authOptions: Record<string, unknown> | undefined;

  /** Cached table metadata (schema + row count) per table. */
  private schemaCache = new Map<string, { columns: ColumnInfo[]; numRows?: number }>();

  constructor(options?: BigQueryOptions) {
    this.options = options ?? {};
  }

  /**
   * Ensure the connector is in a base connected state (has client and projectId).
   * @throws {ConnectionError} if not connected.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.client) {
      throw new ConnectionError('Not connected. Call connect() first.', {
        code: 'VENOMOUS_NOT_CONNECTED',
        connector: CONNECTOR_NAME,
      });
    }
  }

  /**
   * Ensure the connector is fully connected with a selected dataset.
   * @throws {ConnectionError} if not connected or no dataset selected.
   */
  private ensureDatasetReady(): void {
    this.ensureConnected();
    if (!this.datasetId || !this.dataset) {
      throw new ConnectionError(
        'No dataset selected. Pass datasetId in options or call useDataset() after connect().',
        { code: 'VENOMOUS_NO_DATASET', connector: CONNECTOR_NAME }
      );
    }
  }

  /**
   * Get or populate the metadata cache for a table.
   * Returns cached columns and numRows, fetching metadata only once.
   */
  private async getTableMetadata(
    tableName: string
  ): Promise<{ columns: ColumnInfo[]; numRows?: number }> {
    const cached = this.schemaCache.get(tableName);
    if (cached) {
      return cached;
    }

    this.ensureDatasetReady();
    try {
      const table = this.dataset!.table(tableName);
      const [metadata] = await table.getMetadata();
      const columns = mapSchemaFields(metadata.schema);

      const entry = {
        columns,
        numRows: metadata.numRows != null ? Number(metadata.numRows) : undefined,
      };
      this.schemaCache.set(tableName, entry);
      return entry;
    } catch (err) {
      wrapError(err, `Failed to get schema for table "${tableName}"`);
    }
  }

  /**
   * Extract column names from cached schema for validation.
   */
  private async getColumnNames(tableName: string): Promise<Set<string>> {
    const { columns } = await this.getTableMetadata(tableName);
    return new Set(columns.map((col) => col.name));
  }

  /**
   * Connect to BigQuery, initializing the client.
   *
   * If `projectId` was not provided in constructor options, it will be inferred from:
   * - `service-account`: the key file's `project_id` field
   * - `service-account-json`: the credentials object's `project_id` field
   * - `auto`: the SDK's internal project resolution (e.g., `GOOGLE_CLOUD_PROJECT` env var)
   *
   * Calling `connect()` on an already-connected instance will disconnect first (idempotent).
   *
   * @param auth - Auth configuration (defaults to auto/ADC if undefined).
   * @throws {ConnectionError} if connection fails or projectId cannot be determined.
   * @throws {AuthenticationError} if credentials are invalid.
   */
  async connect(auth?: BigQueryAuth): Promise<void> {
    // Idempotent: disconnect first if already connected
    if (this.connected) {
      await this.disconnect();
    }

    const sdkOptions = resolveAuth(auth);
    this.authOptions = sdkOptions as Record<string, unknown>;

    // Determine projectId
    let projectId = this.options.projectId;
    if (!projectId) {
      try {
        projectId = resolveProjectId(auth);
      } catch (err) {
        wrapError(err, 'Failed to resolve projectId from auth config');
      }
    }

    // Initialize BigQuery client
    this.client = new BigQuery({
      ...sdkOptions,
      ...(projectId ? { projectId } : {}),
      ...(this.options.location ? { location: this.options.location } : {}),
    });

    // If datasetId was provided, set up dataset reference
    if (this.options.datasetId) {
      this.datasetId = this.options.datasetId;
      this.dataset = this.client.dataset(this.datasetId);
    }

    // Validate connection with a lightweight query
    try {
      await this.client.query({ query: 'SELECT 1', location: this.options.location });
    } catch (err) {
      this.client = null;
      this.dataset = null;
      this.datasetId = undefined;
      this.authOptions = undefined;
      wrapError(err, 'Failed to connect to BigQuery');
    }

    // Get the actual projectId (auto mode may have it resolved by SDK)
    this.projectId = this.client.projectId;
    if (!this.projectId) {
      this.client = null;
      this.dataset = null;
      this.datasetId = undefined;
      this.authOptions = undefined;
      throw new ConnectionError(
        'Could not determine projectId. Pass projectId in options, provide a service account key, or set GOOGLE_CLOUD_PROJECT environment variable.',
        { code: 'VENOMOUS_NO_PROJECT', connector: CONNECTOR_NAME }
      );
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.dataset = null;
    this.connected = false;
    this.projectId = undefined;
    this.datasetId = undefined;
    this.authOptions = undefined;
    this.schemaCache.clear();
  }

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
   * await connector.connect({ type: 'service-account', keyFilePath: '/path/to/key.json' });
   *
   * const datasets = await connector.datasets();
   * connector.useDataset(datasets[0].datasetId);
   * const tables = await connector.tables();
   * ```
   */
  useDataset(datasetId: string): void {
    this.ensureConnected();

    if (!datasetId) {
      throw new QueryError('datasetId must not be empty', {
        code: 'VENOMOUS_INVALID_OPTIONS',
        connector: CONNECTOR_NAME,
      });
    }

    this.datasetId = datasetId;
    this.dataset = this.client!.dataset(datasetId);
    this.schemaCache.clear();
  }

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
  async datasets(projectId?: string): Promise<DatasetInfo[]> {
    this.ensureConnected();

    const targetProjectId = projectId || this.projectId!;

    let client: BigQuery;
    if (targetProjectId === this.projectId) {
      client = this.client!;
    } else {
      client = new BigQuery({
        ...this.authOptions,
        projectId: targetProjectId,
        ...(this.options.location ? { location: this.options.location } : {}),
      });
    }

    try {
      const [datasets] = await client.getDatasets();
      return datasets.map((ds) => ({
        datasetId: ds.id!,
        location: ds.metadata?.location as string | undefined,
      }));
    } catch (err) {
      wrapError(err, `Failed to list datasets for project "${targetProjectId}"`);
    }
  }

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
   * await connector.connect({ type: 'service-account', keyFilePath: '/path/to/key.json' });
   * const projects = await connector.projects();
   * console.log(projects); // [{ projectId: 'proj-1', displayName: 'My Project', state: 'ACTIVE' }]
   * ```
   */
  async projects(): Promise<ProjectInfo[]> {
    this.ensureConnected();

    let mod: typeof import('@google-cloud/resource-manager');

    try {
      mod = await import('@google-cloud/resource-manager');
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        ((err as { code?: string }).code === 'MODULE_NOT_FOUND' ||
          (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      ) {
        throw new ConnectionError(
          '@google-cloud/resource-manager is required for listing projects. Install it with: npm install @google-cloud/resource-manager',
          { code: 'VENOMOUS_MISSING_DEPENDENCY', connector: CONNECTOR_NAME }
        );
      }
      throw err;
    }

    const projectsClient = new mod.ProjectsClient(
      this.authOptions as ConstructorParameters<typeof mod.ProjectsClient>[0]
    );
    try {
      const results: ProjectInfo[] = [];
      for await (const project of projectsClient.searchProjectsAsync({ query: '' })) {
        if (project.state === 'ACTIVE') {
          results.push({
            projectId: project.projectId!,
            displayName: project.displayName || '',
            state: project.state,
          });
        }
      }
      return results;
    } catch (err) {
      if (err instanceof Error) {
        const message = err.message || '';
        if (message.includes('PERMISSION_DENIED')) {
          throw new PermissionError(`Permission denied when listing projects: ${message}`, {
            cause: err,
            connector: CONNECTOR_NAME,
          });
        }
        if (message.includes('UNAUTHENTICATED')) {
          throw new AuthenticationError(`Authentication failed when listing projects: ${message}`, {
            cause: err,
            connector: CONNECTOR_NAME,
          });
        }
        if (
          message.includes('ECONNREFUSED') ||
          message.includes('ETIMEDOUT') ||
          message.includes('ENOTFOUND')
        ) {
          throw new ConnectionError(`Connection failed when listing projects: ${message}`, {
            cause: err,
            connector: CONNECTOR_NAME,
          });
        }
      }
      wrapError(err, 'Failed to list projects');
    } finally {
      await projectsClient.close();
    }
  }

  async tables(): Promise<TableInfo[]> {
    this.ensureDatasetReady();

    try {
      const [tables] = await this.dataset!.getTables();
      const results: TableInfo[] = [];

      for (const table of tables) {
        const metadata = table.metadata;
        const columns = mapSchemaFields(metadata?.schema);

        const tableName =
          table.id ?? (metadata?.tableReference as { tableId?: string } | undefined)?.tableId;

        if (!tableName) {
          // Skip tables with no identifiable name (should not happen in practice)
          continue;
        }

        const numRows = metadata?.numRows != null ? Number(metadata.numRows) : undefined;

        // Populate schema cache for subsequent peek()/find() calls
        this.schemaCache.set(tableName, { columns, numRows });

        results.push({
          name: tableName,
          schema: columns,
          rowCount: numRows,
        });
      }

      return results;
    } catch (err) {
      wrapError(err, 'Failed to list tables');
    }
  }

  async peek(table: string, options?: PeekOptions): Promise<PeekResult> {
    this.ensureDatasetReady();
    validateIdentifier(table, 'table name');

    let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
    if (rows < 1) rows = 1;
    if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;

    const fqTable = `\`${this.projectId!}.${this.datasetId!}.${table}\``;
    const query = `SELECT * FROM ${fqTable} LIMIT ${rows}`;

    try {
      const [queryRows] = await this.client!.query({
        query,
        location: this.options.location,
      });

      // Get column metadata and row count from a single cached getMetadata call
      const { columns, numRows } = await this.getTableMetadata(table);

      return {
        data: queryRows as Row[],
        columns: columns.length > 0 ? columns : undefined,
        totalRows: numRows,
      };
    } catch (err) {
      wrapError(err, `Failed to peek table "${table}"`);
    }
  }

  async find(table: string, options?: FindOptions): Promise<PageResult<Row>> {
    this.ensureDatasetReady();
    validateIdentifier(table, 'table name');

    const knownColumns = await this.getColumnNames(table);
    const fqTable = `\`${this.projectId!}.${this.datasetId!}.${table}\``;

    // Parse pagination
    const pageSize = options?.page?.size
      ? validatePageSize(options.page.size).value
      : DEFAULT_PAGE_SIZE;

    let offset = 0;
    if (options?.page?.cursor) {
      const state = decodeCursor(options.page.cursor);
      if (typeof state['offset'] !== 'number') {
        throw new QueryError('Invalid cursor: missing offset', {
          code: 'VENOMOUS_INVALID_CURSOR',
          connector: CONNECTOR_NAME,
        });
      }
      offset = state['offset'] as number;
    }

    // Build query parts
    const wherePart = options?.where
      ? buildWhereClause(options.where, knownColumns)
      : { sql: '', params: {} };

    const orderByPart = options?.orderBy ? buildOrderByClause(options.orderBy, knownColumns) : '';

    const query = [
      `SELECT * FROM ${fqTable}`,
      wherePart.sql,
      orderByPart,
      `LIMIT ${pageSize + 1} OFFSET ${offset}`,
    ]
      .filter(Boolean)
      .join(' ');

    try {
      const [rows] = await this.client!.query({
        query,
        params: wherePart.params,
        location: this.options.location,
      });

      const typedRows = rows as Row[];
      const hasMore = typedRows.length > pageSize;
      const data = hasMore ? typedRows.slice(0, pageSize) : typedRows;
      const nextCursor = hasMore ? encodeCursor({ offset: offset + pageSize }) : undefined;

      return {
        data,
        nextCursor,
        hasMore,
      };
    } catch (err) {
      wrapError(err, `Failed to query table "${table}"`);
    }
  }

  sql(query: string, params?: unknown[]): AsyncIterable<Row> {
    const connector = this;

    async function* generate(): AsyncGenerator<Row> {
      connector.ensureConnected();

      // Convert positional params (?) to named params (@p0, @p1, ...) for BigQuery
      const namedParams: Record<string, unknown> = {};
      let processedQuery = query;

      if (params && params.length > 0) {
        let paramIndex = 0;

        // Simple lexical scan: replace `?` placeholders while skipping
        // characters inside single-quoted SQL string literals.
        const chars = [...query];
        const parts: string[] = [];
        let i = 0;

        while (i < chars.length) {
          if (chars[i] === "'") {
            // Inside a single-quoted string literal -- copy verbatim until
            // the closing quote (handling escaped quotes '' per SQL standard).
            parts.push(chars[i]!);
            i++;
            while (i < chars.length) {
              parts.push(chars[i]!);
              if (chars[i] === "'" && chars[i + 1] === "'") {
                // Escaped quote
                parts.push(chars[i + 1]!);
                i += 2;
              } else if (chars[i] === "'") {
                i++;
                break;
              } else {
                i++;
              }
            }
          } else if (chars[i] === '?') {
            const name = `p${paramIndex}`;
            namedParams[name] = params[paramIndex];
            paramIndex++;
            parts.push(`@${name}`);
            i++;
          } else {
            parts.push(chars[i]!);
            i++;
          }
        }

        processedQuery = parts.join('');

        // Validate that placeholder count matches params length
        if (paramIndex !== params.length) {
          throw new QueryError(
            `Parameter count mismatch: query contains ${paramIndex} placeholder(s) but ${params.length} parameter(s) were provided.`,
            { code: 'VENOMOUS_PARAM_MISMATCH', connector: CONNECTOR_NAME }
          );
        }
      }

      try {
        const [job] = await connector.client!.createQueryJob({
          query: processedQuery,
          params: namedParams,
          location: connector.options.location,
        });

        let pageToken: string | undefined;

        do {
          const [rows, , response] = await job.getQueryResults({
            pageToken,
            maxResults: 1000,
          });

          for (const row of rows as Row[]) {
            yield row;
          }

          pageToken = response?.pageToken;
        } while (pageToken);
      } catch (err) {
        wrapError(err, 'Failed to execute SQL query');
      }
    }

    return generate();
  }

  async insert(table: string, rows: Row[]): Promise<InsertResult> {
    this.ensureDatasetReady();
    validateIdentifier(table, 'table name');

    if (rows.length === 0) {
      return { insertedCount: 0 };
    }

    const tableRef = this.dataset!.table(table);

    try {
      await tableRef.insert(rows);
      return { insertedCount: rows.length };
    } catch (err) {
      // BigQuery streaming insert returns partial failure info.
      // The SDK's PartialFailureError.errors array may contain multiple
      // entries per row (one per validation error). We deduplicate by row
      // index to get the accurate count of failed rows.
      if (
        err instanceof Error &&
        'errors' in err &&
        Array.isArray((err as Record<string, unknown>)['errors'])
      ) {
        const errors = (err as Record<string, unknown>)['errors'] as Array<{ row?: number }>;
        const failedRowIndices = new Set(errors.map((e) => e.row));
        const failedCount = failedRowIndices.size > 0 ? failedRowIndices.size : errors.length;
        const insertedCount = rows.length - failedCount;

        throw new QueryError(
          `Partial insert failure: ${insertedCount}/${rows.length} rows inserted, ${failedCount} failed`,
          { cause: err, connector: CONNECTOR_NAME }
        );
      }

      wrapError(err, `Failed to insert into table "${table}"`);
    }
  }

  async update(table: string, options: UpdateOptions): Promise<UpdateResult> {
    this.ensureDatasetReady();
    validateIdentifier(table, 'table name');

    // Reject empty where (prevent full-table update)
    if (!options.where || options.where.length === 0) {
      throw new QueryError('WHERE clause is required for update. Use sql() for unrestricted DML.', {
        code: 'VENOMOUS_EMPTY_WHERE',
        connector: CONNECTOR_NAME,
      });
    }

    const knownColumns = await this.getColumnNames(table);
    const fqTable = `\`${this.projectId!}.${this.datasetId!}.${table}\``;

    // Build SET clause
    const setParts: string[] = [];
    const setParams: Record<string, unknown> = {};
    let setIdx = 0;

    for (const [col, value] of Object.entries(options.set)) {
      validateIdentifier(col, 'column name');
      if (knownColumns.size > 0 && !knownColumns.has(col)) {
        throw new QueryError(`Unknown column in SET: "${col}"`, {
          code: 'VENOMOUS_UNKNOWN_COLUMN',
          connector: CONNECTOR_NAME,
        });
      }
      const paramName = `s${setIdx}`;
      setParts.push(`${escapeIdentifier(col)} = @${paramName}`);
      setParams[paramName] = value;
      setIdx++;
    }

    // Build WHERE clause
    const wherePart = buildWhereClause(options.where, knownColumns);

    const query = `UPDATE ${fqTable} SET ${setParts.join(', ')} ${wherePart.sql}`;
    const allParams = { ...setParams, ...wherePart.params };

    try {
      const [job] = await this.client!.createQueryJob({
        query,
        params: allParams,
        location: this.options.location,
      });

      const [metadata] = await job.getMetadata();
      const affectedRows = Number(metadata.statistics?.query?.numDmlAffectedRows ?? 0);

      return { updatedCount: affectedRows };
    } catch (err) {
      wrapError(err, `Failed to update table "${table}"`);
    }
  }

  async remove(table: string, options: WhereOptions): Promise<DeleteResult> {
    this.ensureDatasetReady();
    validateIdentifier(table, 'table name');

    // Reject empty where (prevent full-table delete)
    if (!options.where || options.where.length === 0) {
      throw new QueryError('WHERE clause is required for delete. Use sql() for unrestricted DML.', {
        code: 'VENOMOUS_EMPTY_WHERE',
        connector: CONNECTOR_NAME,
      });
    }

    const knownColumns = await this.getColumnNames(table);
    const fqTable = `\`${this.projectId!}.${this.datasetId!}.${table}\``;

    const wherePart = buildWhereClause(options.where, knownColumns);
    const query = `DELETE FROM ${fqTable} ${wherePart.sql}`;

    try {
      const [job] = await this.client!.createQueryJob({
        query,
        params: wherePart.params,
        location: this.options.location,
      });

      const [metadata] = await job.getMetadata();
      const affectedRows = Number(metadata.statistics?.query?.numDmlAffectedRows ?? 0);

      return { deletedCount: affectedRows };
    } catch (err) {
      wrapError(err, `Failed to delete from table "${table}"`);
    }
  }
}
