import { BigQuery } from "@google-cloud/bigquery";
import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, validatePageSize } from "../core/index.js";

//#region src/bigquery/auth.ts
/**
* Resolve a BigQueryAuth config into SDK client options.
*
* @param auth - Auth configuration. `type` can be omitted (defaults to `'credentials'`).
* @returns BigQuery SDK options suitable for `new BigQuery(options)`.
*
* @example
* ```typescript
* const opts = resolveAuth({ credentials: {...} });
* // { credentials: {...} }
* ```
*/
function resolveAuth(auth) {
	if (!auth.type || auth.type === "credentials") return { credentials: auth.credentials };
	throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}
/**
* Extract project_id from auth config, if available.
*
* Extracts `project_id` from the credentials object.
* Empty strings are treated as unavailable (returns `undefined`).
*
* @param auth - Auth configuration. `type` can be omitted (defaults to `'credentials'`).
* @returns The project_id string, or undefined if not available.
*
* @example
* ```typescript
* const projectId = resolveProjectId({ credentials: { project_id: 'my-project' } });
* // 'my-project'
* ```
*/
function resolveProjectId(auth) {
	if (!auth.type || auth.type === "credentials") return auth.credentials.project_id || void 0;
	throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}

//#endregion
//#region src/bigquery/connector.ts
const CONNECTOR_NAME = "bigquery";
const DEFAULT_PEEK_ROWS = 10;
const MAX_PEEK_ROWS = 1e3;
const DEFAULT_PAGE_SIZE = 50;
/** Regex pattern for valid BigQuery identifiers (table/column names). */
const VALID_IDENTIFIER = /^[a-zA-Z0-9_-]+$/;
/**
* Validate that a string is a safe BigQuery identifier.
* Prevents SQL injection through table/column names.
*/
function validateIdentifier(name, label) {
	if (!name || !VALID_IDENTIFIER.test(name)) throw new QueryError(`Invalid ${label}: "${name}". Only alphanumeric characters, underscores, and hyphens are allowed.`, {
		code: "VENOMOUS_INVALID_IDENTIFIER",
		connector: CONNECTOR_NAME
	});
}
/**
* Escape a BigQuery identifier with backticks.
*/
function escapeIdentifier(name) {
	return `\`${name}\``;
}
/**
* Map BigQuery SDK errors to appropriate VenomousError subclasses.
*/
function wrapError(err, defaultMessage) {
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const errCode = err.code;
		if (errCode === 401) throw new AuthenticationError(`BigQuery authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errCode === 403) throw new PermissionError(`BigQuery permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errCode === 404) throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("Could not load the default credentials") || message.includes("invalid_grant") || message.includes("UNAUTHENTICATED") || message.includes("credentials are required") || message.includes("credentials are not valid")) throw new AuthenticationError(`BigQuery authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("PERMISSION_DENIED")) throw new PermissionError(`BigQuery permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("Not found") || message.includes("notFound")) throw new NotFoundError(message, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND") || message.includes("network error") || message.includes("Network Error")) throw new ConnectionError(`BigQuery connection failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`BigQuery query failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(defaultMessage, { connector: CONNECTOR_NAME });
}
/**
* Build a parameterized WHERE clause from a WhereClause array.
*
* @returns Object with `sql` string and `params` record for BigQuery named params.
*/
function buildWhereClause(where, knownColumns) {
	if (where.length === 0) return {
		sql: "",
		params: {}
	};
	const conditions = [];
	const params = {};
	for (let i = 0; i < where.length; i++) {
		const condition = where[i];
		validateIdentifier(condition.field, "column name");
		if (knownColumns.size > 0 && !knownColumns.has(condition.field)) throw new QueryError(`Unknown column: "${condition.field}". Known columns: ${[...knownColumns].join(", ")}`, {
			code: "VENOMOUS_UNKNOWN_COLUMN",
			connector: CONNECTOR_NAME
		});
		const col = escapeIdentifier(condition.field);
		const paramName = `p${i}`;
		switch (condition.operator) {
			case "eq":
				if (condition.value === null) conditions.push(`${col} IS NULL`);
				else {
					conditions.push(`${col} = @${paramName}`);
					params[paramName] = condition.value;
				}
				break;
			case "ne":
				if (condition.value === null) conditions.push(`${col} IS NOT NULL`);
				else {
					conditions.push(`${col} != @${paramName}`);
					params[paramName] = condition.value;
				}
				break;
			case "gt":
				conditions.push(`${col} > @${paramName}`);
				params[paramName] = condition.value;
				break;
			case "lt":
				conditions.push(`${col} < @${paramName}`);
				params[paramName] = condition.value;
				break;
			case "gte":
				conditions.push(`${col} >= @${paramName}`);
				params[paramName] = condition.value;
				break;
			case "lte":
				conditions.push(`${col} <= @${paramName}`);
				params[paramName] = condition.value;
				break;
			case "in":
				conditions.push(`${col} IN UNNEST(@${paramName})`);
				params[paramName] = condition.value;
				break;
			case "like":
				conditions.push(`${col} LIKE @${paramName}`);
				params[paramName] = condition.value;
				break;
			default: {
				const _exhaustive = condition.operator;
				throw new QueryError(`Unsupported operator: "${String(_exhaustive)}"`, {
					code: "VENOMOUS_UNSUPPORTED_OPERATOR",
					connector: CONNECTOR_NAME
				});
			}
		}
	}
	return {
		sql: `WHERE ${conditions.join(" AND ")}`,
		params
	};
}
/**
* Build an ORDER BY clause from OrderByClause array.
*/
function buildOrderByClause(orderBy, knownColumns) {
	if (orderBy.length === 0) return "";
	const parts = [];
	for (const clause of orderBy) {
		validateIdentifier(clause.field, "column name");
		if (knownColumns.size > 0 && !knownColumns.has(clause.field)) throw new QueryError(`Unknown column in ORDER BY: "${clause.field}"`, {
			code: "VENOMOUS_UNKNOWN_COLUMN",
			connector: CONNECTOR_NAME
		});
		parts.push(`${escapeIdentifier(clause.field)} ${clause.direction === "desc" ? "DESC" : "ASC"}`);
	}
	return `ORDER BY ${parts.join(", ")}`;
}
/**
* Map BigQuery schema fields to ColumnInfo array.
*/
function mapSchemaFields(schema) {
	if (!schema?.fields) return [];
	return schema.fields.map((field) => ({
		name: field.name,
		type: field.type,
		nullable: field.mode !== "REQUIRED",
		description: field.description || void 0
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
var BigQueryConnector = class {
	options;
	projectId;
	datasetId;
	client = null;
	dataset = null;
	connected = false;
	authOptions;
	/** Cached table metadata (schema + row count) per table. */
	schemaCache = new Map();
	constructor(options) {
		this.options = options ?? {};
	}
	/**
	* Ensure the connector is in a base connected state (has client and projectId).
	* @throws {ConnectionError} if not connected.
	*/
	ensureConnected() {
		if (!this.connected || !this.client) throw new ConnectionError("Not connected. Call connect() first.", {
			code: "VENOMOUS_NOT_CONNECTED",
			connector: CONNECTOR_NAME
		});
	}
	/**
	* Ensure the connector is fully connected with a selected dataset.
	* @throws {ConnectionError} if not connected or no dataset selected.
	*/
	ensureDatasetReady() {
		this.ensureConnected();
		if (!this.datasetId || !this.dataset) throw new ConnectionError("No dataset selected. Pass datasetId in options or call useDataset() after connect().", {
			code: "VENOMOUS_NO_DATASET",
			connector: CONNECTOR_NAME
		});
	}
	/**
	* Get or populate the metadata cache for a table.
	* Returns cached columns and numRows, fetching metadata only once.
	*/
	async getTableMetadata(tableName) {
		const cached = this.schemaCache.get(tableName);
		if (cached) return cached;
		this.ensureDatasetReady();
		try {
			const table = this.dataset.table(tableName);
			const [metadata] = await table.getMetadata();
			const columns = mapSchemaFields(metadata.schema);
			const entry = {
				columns,
				numRows: metadata.numRows != null ? Number(metadata.numRows) : void 0
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
	async getColumnNames(tableName) {
		const { columns } = await this.getTableMetadata(tableName);
		return new Set(columns.map((col) => col.name));
	}
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
	async connect(auth) {
		if (this.connected) await this.disconnect();
		if (!auth) throw new AuthenticationError("BigQuery requires explicit authentication. Use { credentials: {...} }.", {
			code: "VENOMOUS_AUTH_REQUIRED",
			connector: CONNECTOR_NAME
		});
		const sdkOptions = resolveAuth(auth);
		this.authOptions = sdkOptions;
		let projectId = this.options.projectId;
		if (!projectId) try {
			projectId = resolveProjectId(auth);
		} catch (err) {
			wrapError(err, "Failed to resolve projectId from auth config");
		}
		this.client = new BigQuery({
			...sdkOptions,
			...projectId ? { projectId } : {},
			...this.options.location ? { location: this.options.location } : {}
		});
		if (this.options.datasetId) {
			this.datasetId = this.options.datasetId;
			this.dataset = this.client.dataset(this.datasetId);
		}
		try {
			await this.client.createQueryJob({
				query: "SELECT 1",
				dryRun: true,
				location: this.options.location
			});
		} catch (err) {
			this.client = null;
			this.dataset = null;
			this.datasetId = void 0;
			this.authOptions = void 0;
			wrapError(err, "Failed to connect to BigQuery");
		}
		this.projectId = this.client.projectId;
		if (!this.projectId) {
			this.client = null;
			this.dataset = null;
			this.datasetId = void 0;
			this.authOptions = void 0;
			throw new ConnectionError("Could not determine projectId. Pass projectId in options, provide a service account key, or set GOOGLE_CLOUD_PROJECT environment variable.", {
				code: "VENOMOUS_NO_PROJECT",
				connector: CONNECTOR_NAME
			});
		}
		if (this.dataset) try {
			const [exists] = await this.dataset.exists();
			if (!exists) {
				const dsId = this.datasetId;
				const projId = this.projectId;
				this.client = null;
				this.dataset = null;
				this.datasetId = void 0;
				this.projectId = void 0;
				this.authOptions = void 0;
				throw new NotFoundError(`Dataset "${dsId}" not found in project "${projId}"`, {
					code: "VENOMOUS_NOT_FOUND",
					connector: CONNECTOR_NAME
				});
			}
		} catch (err) {
			if (err instanceof NotFoundError) throw err;
			const dsId = this.datasetId;
			this.client = null;
			this.dataset = null;
			this.datasetId = void 0;
			this.projectId = void 0;
			this.authOptions = void 0;
			wrapError(err, `Failed to verify dataset "${dsId}"`);
		}
		this.connected = true;
	}
	async disconnect() {
		this.client = null;
		this.dataset = null;
		this.connected = false;
		this.projectId = void 0;
		this.datasetId = void 0;
		this.authOptions = void 0;
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
	* await connector.connect({ credentials: {...} });
	*
	* const datasets = await connector.datasets();
	* await connector.useDataset(datasets[0].datasetId);
	* const tables = await connector.tables();
	* ```
	*/
	async useDataset(datasetId) {
		this.ensureConnected();
		if (!datasetId) throw new QueryError("datasetId must not be empty", {
			code: "VENOMOUS_INVALID_OPTIONS",
			connector: CONNECTOR_NAME
		});
		const ds = this.client.dataset(datasetId);
		try {
			const [exists] = await ds.exists();
			if (!exists) throw new NotFoundError(`Dataset "${datasetId}" not found in project "${this.projectId}"`, {
				code: "VENOMOUS_NOT_FOUND",
				connector: CONNECTOR_NAME
			});
		} catch (err) {
			if (err instanceof NotFoundError) throw err;
			wrapError(err, `Failed to verify dataset "${datasetId}"`);
		}
		this.datasetId = datasetId;
		this.dataset = ds;
		this.schemaCache.clear();
	}
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
	async dryRun(sql, params) {
		this.ensureConnected();
		const converted = this.convertPositionalParams(sql, params);
		try {
			const [, apiResponse] = await this.client.createQueryJob({
				query: converted.query,
				params: converted.params,
				dryRun: true,
				location: this.options.location
			});
			const stats = apiResponse?.statistics?.query;
			const totalBytesProcessed = stats?.totalBytesProcessed ? Number(stats.totalBytesProcessed) : 0;
			const schema = mapSchemaFields(stats?.schema);
			return {
				totalBytesProcessed,
				schema
			};
		} catch (err) {
			wrapError(err, "Failed to dry-run query");
		}
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
	async datasets(projectId) {
		this.ensureConnected();
		const targetProjectId = projectId || this.projectId;
		let client;
		if (targetProjectId === this.projectId) client = this.client;
		else client = new BigQuery({
			...this.authOptions,
			projectId: targetProjectId,
			...this.options.location ? { location: this.options.location } : {}
		});
		try {
			const [datasets] = await client.getDatasets();
			return datasets.map((ds) => ({
				datasetId: ds.id,
				location: ds.metadata?.location
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
	* await connector.connect({ credentials: {...} });
	* const projects = await connector.projects();
	* console.log(projects); // [{ projectId: 'proj-1', displayName: 'My Project', state: 'ACTIVE' }]
	* ```
	*/
	async projects() {
		this.ensureConnected();
		let mod;
		try {
			mod = await import("@google-cloud/resource-manager");
		} catch (err) {
			if (err instanceof Error && "code" in err && (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND")) throw new ConnectionError("@google-cloud/resource-manager is required for listing projects. Install it with: npm install @google-cloud/resource-manager", {
				code: "VENOMOUS_MISSING_DEPENDENCY",
				connector: CONNECTOR_NAME
			});
			throw err;
		}
		const projectsClient = new mod.ProjectsClient(this.authOptions);
		try {
			const results = [];
			for await (const project of projectsClient.searchProjectsAsync({ query: "" })) if (project.state === "ACTIVE") results.push({
				projectId: project.projectId,
				displayName: project.displayName || "",
				state: project.state
			});
			return results;
		} catch (err) {
			if (err instanceof Error) {
				const message = err.message || "";
				if (message.includes("PERMISSION_DENIED")) throw new PermissionError(`Permission denied when listing projects: ${message}`, {
					cause: err,
					connector: CONNECTOR_NAME
				});
				if (message.includes("UNAUTHENTICATED")) throw new AuthenticationError(`Authentication failed when listing projects: ${message}`, {
					cause: err,
					connector: CONNECTOR_NAME
				});
				if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) throw new ConnectionError(`Connection failed when listing projects: ${message}`, {
					cause: err,
					connector: CONNECTOR_NAME
				});
			}
			wrapError(err, "Failed to list projects");
		} finally {
			await projectsClient.close();
		}
	}
	async tables() {
		this.ensureDatasetReady();
		try {
			const [tables] = await this.dataset.getTables();
			const results = [];
			for (const table of tables) {
				const metadata = table.metadata;
				const columns = mapSchemaFields(metadata?.schema);
				const tableName = table.id ?? (metadata?.tableReference)?.tableId;
				if (!tableName) continue;
				const numRows = metadata?.numRows != null ? Number(metadata.numRows) : void 0;
				this.schemaCache.set(tableName, {
					columns,
					numRows
				});
				results.push({
					name: tableName,
					schema: columns,
					rowCount: numRows
				});
			}
			return results;
		} catch (err) {
			wrapError(err, "Failed to list tables");
		}
	}
	async peek(table, options) {
		this.ensureDatasetReady();
		validateIdentifier(table, "table name");
		let rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		if (rows < 1) rows = 1;
		if (rows > MAX_PEEK_ROWS) rows = MAX_PEEK_ROWS;
		const fqTable = `\`${this.projectId}.${this.datasetId}.${table}\``;
		const query = `SELECT * FROM ${fqTable} LIMIT ${rows}`;
		try {
			const [queryRows] = await this.client.query({
				query,
				location: this.options.location
			});
			const { columns, numRows } = await this.getTableMetadata(table);
			return {
				data: queryRows,
				columns: columns.length > 0 ? columns : void 0,
				totalRows: numRows
			};
		} catch (err) {
			wrapError(err, `Failed to peek table "${table}"`);
		}
	}
	async find(table, options) {
		this.ensureDatasetReady();
		validateIdentifier(table, "table name");
		const knownColumns = await this.getColumnNames(table);
		const fqTable = `\`${this.projectId}.${this.datasetId}.${table}\``;
		const pageSize = options?.page?.size ? validatePageSize(options.page.size).value : DEFAULT_PAGE_SIZE;
		let offset = 0;
		if (options?.page?.cursor) {
			const state = decodeCursor(options.page.cursor);
			if (typeof state["offset"] !== "number") throw new QueryError("Invalid cursor: missing offset", {
				code: "VENOMOUS_INVALID_CURSOR",
				connector: CONNECTOR_NAME
			});
			offset = state["offset"];
		}
		const wherePart = options?.where ? buildWhereClause(options.where, knownColumns) : {
			sql: "",
			params: {}
		};
		const orderByPart = options?.orderBy ? buildOrderByClause(options.orderBy, knownColumns) : "";
		const query = [
			`SELECT * FROM ${fqTable}`,
			wherePart.sql,
			orderByPart,
			`LIMIT ${pageSize + 1} OFFSET ${offset}`
		].filter(Boolean).join(" ");
		try {
			const [rows] = await this.client.query({
				query,
				params: wherePart.params,
				location: this.options.location
			});
			const typedRows = rows;
			const hasMore = typedRows.length > pageSize;
			const data = hasMore ? typedRows.slice(0, pageSize) : typedRows;
			const nextCursor = hasMore ? encodeCursor({ offset: offset + pageSize }) : void 0;
			return {
				data,
				nextCursor,
				hasMore
			};
		} catch (err) {
			wrapError(err, `Failed to query table "${table}"`);
		}
	}
	/**
	* Convert positional `?` placeholders to BigQuery named parameters (`@p0`, `@p1`, ...).
	*
	* Skips `?` characters inside single-quoted SQL string literals.
	*
	* @throws {QueryError} if placeholder count does not match params length.
	*/
	convertPositionalParams(query, params) {
		if (!params || params.length === 0) return {
			query,
			params: {}
		};
		const namedParams = {};
		let paramIndex = 0;
		const chars = [...query];
		const parts = [];
		let i = 0;
		while (i < chars.length) if (chars[i] === "'") {
			parts.push(chars[i]);
			i++;
			while (i < chars.length) {
				parts.push(chars[i]);
				if (chars[i] === "'" && chars[i + 1] === "'") {
					parts.push(chars[i + 1]);
					i += 2;
				} else if (chars[i] === "'") {
					i++;
					break;
				} else i++;
			}
		} else if (chars[i] === "?") {
			const name = `p${paramIndex}`;
			namedParams[name] = params[paramIndex];
			paramIndex++;
			parts.push(`@${name}`);
			i++;
		} else {
			parts.push(chars[i]);
			i++;
		}
		const processedQuery = parts.join("");
		if (paramIndex !== params.length) throw new QueryError(`Parameter count mismatch: query contains ${paramIndex} placeholder(s) but ${params.length} parameter(s) were provided.`, {
			code: "VENOMOUS_PARAM_MISMATCH",
			connector: CONNECTOR_NAME
		});
		return {
			query: processedQuery,
			params: namedParams
		};
	}
	sql(query, params) {
		const convertParams = (q, p) => this.convertPositionalParams(q, p);
		const ensureConnected = () => this.ensureConnected();
		const getClient = () => this.client;
		const { location } = this.options;
		async function* generate() {
			ensureConnected();
			const { query: processedQuery, params: namedParams } = convertParams(query, params);
			try {
				const [job] = await getClient().createQueryJob({
					query: processedQuery,
					params: namedParams,
					location
				});
				let pageToken;
				do {
					const [rows, , response] = await job.getQueryResults({
						pageToken,
						maxResults: 1e3
					});
					for (const row of rows) yield row;
					pageToken = response?.pageToken;
				} while (pageToken);
			} catch (err) {
				wrapError(err, "Failed to execute SQL query");
			}
		}
		return generate();
	}
	async insert(table, rows) {
		this.ensureDatasetReady();
		validateIdentifier(table, "table name");
		if (rows.length === 0) return { insertedCount: 0 };
		const tableRef = this.dataset.table(table);
		try {
			await tableRef.insert(rows);
			return { insertedCount: rows.length };
		} catch (err) {
			if (err instanceof Error && "errors" in err && Array.isArray(err["errors"])) {
				const errors = err["errors"];
				const failedRowIndices = new Set(errors.map((e) => e.row));
				const failedCount = failedRowIndices.size > 0 ? failedRowIndices.size : errors.length;
				const insertedCount = rows.length - failedCount;
				throw new QueryError(`Partial insert failure: ${insertedCount}/${rows.length} rows inserted, ${failedCount} failed`, {
					cause: err,
					connector: CONNECTOR_NAME
				});
			}
			wrapError(err, `Failed to insert into table "${table}"`);
		}
	}
	async update(table, options) {
		this.ensureDatasetReady();
		validateIdentifier(table, "table name");
		if (!options.where || options.where.length === 0) throw new QueryError("WHERE clause is required for update. Use sql() for unrestricted DML.", {
			code: "VENOMOUS_EMPTY_WHERE",
			connector: CONNECTOR_NAME
		});
		const knownColumns = await this.getColumnNames(table);
		const fqTable = `\`${this.projectId}.${this.datasetId}.${table}\``;
		const setParts = [];
		const setParams = {};
		let setIdx = 0;
		for (const [col, value] of Object.entries(options.set)) {
			validateIdentifier(col, "column name");
			if (knownColumns.size > 0 && !knownColumns.has(col)) throw new QueryError(`Unknown column in SET: "${col}"`, {
				code: "VENOMOUS_UNKNOWN_COLUMN",
				connector: CONNECTOR_NAME
			});
			const paramName = `s${setIdx}`;
			setParts.push(`${escapeIdentifier(col)} = @${paramName}`);
			setParams[paramName] = value;
			setIdx++;
		}
		const wherePart = buildWhereClause(options.where, knownColumns);
		const query = `UPDATE ${fqTable} SET ${setParts.join(", ")} ${wherePart.sql}`;
		const allParams = {
			...setParams,
			...wherePart.params
		};
		try {
			const [job] = await this.client.createQueryJob({
				query,
				params: allParams,
				location: this.options.location
			});
			const [metadata] = await job.getMetadata();
			const affectedRows = Number(metadata.statistics?.query?.numDmlAffectedRows ?? 0);
			return { updatedCount: affectedRows };
		} catch (err) {
			wrapError(err, `Failed to update table "${table}"`);
		}
	}
	async remove(table, options) {
		this.ensureDatasetReady();
		validateIdentifier(table, "table name");
		if (!options.where || options.where.length === 0) throw new QueryError("WHERE clause is required for delete. Use sql() for unrestricted DML.", {
			code: "VENOMOUS_EMPTY_WHERE",
			connector: CONNECTOR_NAME
		});
		const knownColumns = await this.getColumnNames(table);
		const fqTable = `\`${this.projectId}.${this.datasetId}.${table}\``;
		const wherePart = buildWhereClause(options.where, knownColumns);
		const query = `DELETE FROM ${fqTable} ${wherePart.sql}`;
		try {
			const [job] = await this.client.createQueryJob({
				query,
				params: wherePart.params,
				location: this.options.location
			});
			const [metadata] = await job.getMetadata();
			const affectedRows = Number(metadata.statistics?.query?.numDmlAffectedRows ?? 0);
			return { deletedCount: affectedRows };
		} catch (err) {
			wrapError(err, `Failed to delete from table "${table}"`);
		}
	}
};

//#endregion
//#region src/bigquery/index.ts
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
function createBigQueryConnector(options) {
	return new BigQueryConnector(options);
}

//#endregion
export { BigQueryConnector, createBigQueryConnector };
//# sourceMappingURL=index.js.map