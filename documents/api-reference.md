# API Reference

Core interfaces, types, error classes, and utility functions exported from `venomous-datasource/core`.

---

## Interfaces

### TabularConnector\<TAuth\>

Interface for tabular (structured) data source connectors (e.g., BigQuery).

| Method       | Signature                                       | Description                                  |
| ------------ | ----------------------------------------------- | -------------------------------------------- |
| `connect`    | `(auth?: TAuth) => Promise<void>`               | Connect using provided or `auto` credentials |
| `disconnect` | `() => Promise<void>`                           | Release all resources                        |
| `tables`     | `() => Promise<TableInfo[]>`                    | List available tables                        |
| `peek`       | `(table, options?) => Promise<PeekResult>`      | Preview first N rows (default: 10)           |
| `find`       | `(table, options?) => Promise<PageResult<Row>>` | Conditional query with pagination            |
| `sql`        | `(query, params?) => AsyncIterable<Row>`        | Execute parameterized SQL, stream rows       |
| `insert` \*  | `(table, rows) => Promise<InsertResult>`        | Insert rows                                  |
| `update` \*  | `(table, options) => Promise<UpdateResult>`     | Update rows matching condition               |
| `remove` \*  | `(table, options) => Promise<DeleteResult>`     | Delete rows matching condition               |

> \* Optional — connectors may omit if the data source is read-only.

### BigQueryConnector

Extends `TabularConnector<BigQueryAuth>` with resource exploration methods. Created via `createBigQueryConnector(options?)` — note that `options` is optional and the return type is `BigQueryConnector` (not `TabularConnector`).

| Method       | Signature                                       | Description                                                             |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `projects`   | `() => Promise<ProjectInfo[]>`                  | List accessible GCP projects (ACTIVE only). Requires `@google-cloud/resource-manager` |
| `datasets`   | `(projectId?) => Promise<DatasetInfo[]>`         | List BigQuery datasets in current or specified project                   |
| `useDataset` | `(datasetId: string) => void`                   | Switch dataset for subsequent table operations. Clears schema cache      |

> `connect()` is idempotent — calling it again will disconnect first, then reconnect. When `projectId` is omitted from options, it is inferred from the auth credentials (service account key file or credentials object).

### SheetsConnector

Extends `TabularConnector<SheetsAuth>`. Created via `createSheetsConnector(options)`. Uses Google Sheets API v4 under the hood.

| Limitation | Details |
| ---------- | ------- |
| `sql()`    | Not supported — throws `QueryError` (`VENOMOUS_NOT_SUPPORTED`) |
| `find()`   | Client-side filtering (loads all rows, filters in memory) |
| `update()` / `remove()` | Locate rows by client-side matching, then operate by row number |

> Schema types are inferred from cell values (100-row sampling): `NUMBER`, `BOOLEAN`, `DATE`, `STRING`. All columns have `nullable: true`.

### DocumentConnector\<TAuth\>

Interface for document-based data source connectors (e.g., Firestore, future MongoDB/DynamoDB).

| Method        | Signature                                                   | Description                                  |
| ------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `connect`     | `(auth?: TAuth) => Promise<void>`                           | Connect using provided or `auto` credentials |
| `disconnect`  | `() => Promise<void>`                                       | Release all resources                        |
| `collections` | `() => Promise<CollectionInfo[]>`                           | List available collections                   |
| `peek`        | `(collection, options?) => Promise<DocPeekResult>`          | Preview first N documents                    |
| `getById`     | `(collection, id) => Promise<Document \| undefined>`        | Get a single document by ID                  |
| `find`        | `(collection, options?) => Promise<PageResult<Document>>`   | Query with server-side filtering             |
| `insert` \*   | `(collection, docs) => Promise<DocInsertResult>`            | Insert documents                             |
| `update` \*   | `(collection, options) => Promise<DocUpdateResult>`         | Update documents matching filter             |
| `remove` \*   | `(collection, options) => Promise<DocDeleteResult>`         | Delete documents matching filter             |

> \* Optional — connectors may omit if the data source is read-only.

Key differences from `TabularConnector`:
- No `sql()` method — document databases don't support SQL
- Uses `Document = { id, data }` instead of `Row` — ID is metadata, not a column
- Uses `DocFilter` / `DocFilterOperator` instead of `WhereClause` — no `like` operator
- `collections()` returns `CollectionInfo` (name only) — no schema or row count

### FirestoreConnector

Extends `DocumentConnector<FirestoreAuth>`. Created via `createFirestoreConnector(options?)`.

| Limitation     | Details |
| -------------- | ------- |
| `in`           | Maximum 30 values per query (Firestore limit) |
| `find()`       | Server-side filtering; complex queries may require composite indexes |
| `update()` / `remove()` | Query-then-modify pattern; empty filter rejected (`VENOMOUS_EMPTY_FILTER`) |

> Field types inferred from sampled documents: `STRING`, `NUMBER`, `BOOLEAN`, `TIMESTAMP`, `GEOPOINT`, `REFERENCE`, `BYTES`, `ARRAY`, `MAP`. Documents are written in batches of 500.

### FileConnector\<TAuth\>

Interface for file-based data source connectors (e.g., S3, GCS).

| Method       | Signature                                            | Description                                  |
| ------------ | ---------------------------------------------------- | -------------------------------------------- |
| `connect`    | `(auth?: TAuth) => Promise<void>`                    | Connect using provided or `auto` credentials |
| `disconnect` | `() => Promise<void>`                                | Release all resources                        |
| `files`      | `(path?, options?) => Promise<PageResult<FileInfo>>` | List files with pagination                   |
| `peek`       | `(path, options?) => Promise<PeekResult>`            | Preview CSV/JSON content (first N rows)      |
| `read`       | `(path) => Promise<ReadableStream<Uint8Array>>`      | Read file as stream                          |
| `stat`       | `(path) => Promise<FileInfo>`                        | Get file metadata                            |
| `write` \*   | `(path, data) => Promise<WriteResult>`               | Write data to file                           |
| `remove` \*  | `(path) => Promise<void>`                            | Delete file (idempotent — succeeds silently if file does not exist) |

> \* Optional — connectors may omit if the storage is read-only.

---

## Types

### Authentication

Most connectors default to `{ type: 'auto' }`, which delegates to the native SDK's credential chain. BigQuery is an exception — it requires explicit authentication (`credentials`).

```typescript
// Base — all connectors support this
interface BaseAuth {
  readonly type: 'auto';
}

// BigQuery (no auto — explicit auth required, type is optional)
type BigQueryAuth = { type?: 'credentials'; credentials: object };

type GCSAuth =
  | BaseAuth
  | { type: 'service-account-json'; credentials: object };

type SheetsAuth =
  | BaseAuth
  | { type: 'service-account-json'; credentials: object };

// Firestore (DocumentConnector — same Google auth modes)
type FirestoreAuth =
  | BaseAuth
  | { type: 'service-account-json'; credentials: object };

// S3
type S3Auth =
  | BaseAuth
  | { type: 'access-key'; accessKeyId: string; secretAccessKey: string; region: string }
  | { type: 'profile'; profileName: string; region?: string };

// Azure Blob Storage
type AzureBlobAuth =
  | BaseAuth
  | { type: 'connection-string'; connectionString: string }
  | { type: 'sas-token'; accountName: string; sasToken: string }
  | { type: 'account-key'; accountName: string; accountKey: string };
```

### Pagination

```typescript
interface PageOptions {
  readonly size?: number; // Items per page. Default: 50, Max: 1000
  readonly cursor?: string; // Opaque cursor from previous result
}

interface PageResult<T> {
  readonly data: T[];
  readonly nextCursor?: string; // undefined = no more pages
  readonly hasMore: boolean;
  readonly total?: number;
}
```

### Query

```typescript
// WHERE operators
type WhereOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'like';

interface WhereCondition {
  readonly field: string;
  readonly operator: WhereOperator;
  readonly value: unknown;
}

// Conditions are ANDed. For OR logic, use sql() instead.
type WhereClause = WhereCondition[];

interface FindOptions {
  readonly where?: WhereClause;
  readonly orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  readonly page?: PageOptions;
}

interface PeekOptions {
  readonly rows?: number; // Default: 10
}

interface ListOptions {
  readonly page?: PageOptions;
}

interface UpdateOptions {
  readonly where: WhereClause;
  readonly set: Record<string, unknown>;
}
```

### Result Types

```typescript
type Row = Record<string, unknown>;

interface ColumnInfo {
  readonly name: string;
  readonly type: string; // Native type from data source
  readonly nullable: boolean;
  readonly description?: string;
}

interface TableInfo {
  readonly name: string;
  readonly schema?: ColumnInfo[];
  readonly rowCount?: number;
}

interface ProjectInfo {
  readonly projectId: string; // GCP project ID
  readonly displayName: string; // Display name
  readonly state: string; // 'ACTIVE', 'DELETE_REQUESTED', etc.
}

interface DatasetInfo {
  readonly datasetId: string; // Dataset ID
  readonly location?: string; // Geographic location (e.g., 'US')
}

interface FileInfo {
  readonly name: string; // Filename without directory
  readonly path: string; // Full path relative to bucket root
  readonly size: number; // Bytes
  readonly lastModified: Date;
  readonly contentType?: string;
  readonly isDirectory: boolean;
}

interface PeekResult {
  readonly data: Row[];
  readonly columns?: ColumnInfo[];
  readonly totalRows?: number;
}

interface InsertResult {
  readonly insertedCount: number;
}
interface UpdateResult {
  readonly updatedCount: number;
}
interface DeleteResult {
  readonly deletedCount: number;
}
interface WriteResult {
  readonly path: string;
  readonly size: number;
}
```

---

## Error Classes

All errors extend `VenomousError` with machine-readable `code`, optional `connector` identifier, cause chaining, and automatic credential redaction in `toJSON()`.

```
VenomousError
├── AuthenticationError    — invalid credentials, expired tokens
├── ConnectionError        — network errors, service unreachable
├── QueryError             — SQL syntax errors, execution failures
├── PathError              — path traversal attacks, encoding errors
├── NotFoundError          — table/file/bucket does not exist
└── PermissionError        — insufficient IAM permissions
```

### Properties

| Property    | Type       | Description                                                 |
| ----------- | ---------- | ----------------------------------------------------------- |
| `code`      | `string`   | Machine-readable code (e.g., `VENOMOUS_AUTH_FAILED`)        |
| `connector` | `string?`  | Connector that produced the error (`bigquery`, `s3`, `gcs`, `google-sheets`, `firestore`, `azure-blob-storage`) |
| `message`   | `string`   | Human-readable description                                  |
| `cause`     | `unknown?` | Original error from the underlying SDK                      |

### Usage

```typescript
import { VenomousError, AuthenticationError } from 'venomous-datasource/core';

try {
  await connector.connect();
  const data = await connector.peek('users');
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error('Auth failed:', err.code, err.message);
  } else if (err instanceof VenomousError) {
    console.error('SDK error:', err.code, err.connector, err.message);
    console.log(JSON.stringify(err)); // credentials auto-redacted
  }
}
```

---

## Utility Functions

Exported from `venomous-datasource/core` for use in custom connectors.

### Path Utilities

| Function        | Signature                   | Description                                                      |
| --------------- | --------------------------- | ---------------------------------------------------------------- |
| `normalizePath` | `(path: string) => string`  | Normalize a file path (resolve `.`/`..`, deduplicate separators) |
| `isPathSafe`    | `(path: string) => boolean` | Check if a path is safe (no traversal attacks)                   |
| `encodeCJK`     | `(path: string) => string`  | NFC-normalize CJK/Unicode filenames                              |

### Sanitization Utilities

| Function        | Signature                  | Description                               |
| --------------- | -------------------------- | ----------------------------------------- |
| `redactAuth`    | `(auth: unknown, additionalFields?: string[]) => unknown` | Redact sensitive fields from auth objects |
| `sanitizeError` | `(error: unknown) => Record<string, unknown>` | Sanitize error for safe logging           |

### Pagination Utilities

| Function           | Signature                     | Description                             |
| ------------------ | ----------------------------- | --------------------------------------- |
| `validatePageSize` | `(size: number) => { value: number; truncated: boolean }` | Clamp page size to valid range (1–1000) |
| `encodeCursor`     | `(state: Record<string, unknown>) => string`  | Encode pagination state to opaque cursor string  |
| `decodeCursor`     | `(cursor: string) => Record<string, unknown>` | Decode an opaque cursor string to pagination state |

### Parser Utilities

Shared CSV/JSON parsing functions used by file connectors. Useful for building custom `FileConnector` implementations.

| Function        | Signature                                                        | Description                                                    |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `parseCsv`      | `(content: string, maxRows: number) => { columns: ColumnInfo[]; data: Row[] }` | Parse CSV text into structured rows with column metadata       |
| `parseJson`     | `(content: string, maxRows: number) => { data: Row[] }`         | Parse JSON array or JSONL text into rows (safe — no content leakage on parse errors) |
| `getFileFormat`  | `(path: string) => 'csv' \| 'json' \| 'jsonl' \| null`          | Detect file format from extension                              |
