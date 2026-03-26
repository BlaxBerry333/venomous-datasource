# Connector Guide

Detailed usage for each supported data source.

---

## BigQuery

**Type:** Tabular (`TabularConnector`)
**Import:** `venomous-datasource/bigquery`
**Peer dependencies:** `@google-cloud/bigquery` + `@google-cloud/resource-manager` (optional, for `projects()`)

### Options

| Option      | Type     | Required | Description                                                       |
| ----------- | -------- | -------- | ----------------------------------------------------------------- |
| `projectId` | `string` | No       | Google Cloud project ID. Inferred from auth credentials if omitted |
| `datasetId` | `string` | No       | BigQuery dataset ID. Can be set later via `useDataset()`           |
| `location`  | `string` | No       | Data location (e.g., `'US'`, `'asia-northeast1'`)                 |

### Authentication

| Type                   | Fields        | Description                               |
| ---------------------- | ------------- | ----------------------------------------- |
| `auto` (default)       | —             | Application Default Credentials (ADC)     |
| `service-account`      | `keyFilePath` | Path to service account JSON key file     |
| `service-account-json` | `credentials` | Inline service account credentials object |

### Usage

#### Traditional (known project + dataset)

```typescript
import { createBigQueryConnector } from 'venomous-datasource/bigquery';

const connector = createBigQueryConnector({
  projectId: 'my-project',
  datasetId: 'my_dataset',
  location: 'US',
});

await connector.connect();
// ... use connector
await connector.disconnect();
```

#### Exploration (discover projects and datasets)

```typescript
import { createBigQueryConnector } from 'venomous-datasource/bigquery';

const connector = createBigQueryConnector();
await connector.connect({
  type: 'service-account',
  keyFilePath: '/path/to/key.json',
});

// List accessible GCP projects (requires @google-cloud/resource-manager)
const projects = await connector.projects();
// [{ projectId: 'my-project', displayName: 'My Project', state: 'ACTIVE' }, ...]

// List datasets in the connected project (or specify another)
const datasets = await connector.datasets();
// [{ datasetId: 'my_dataset', location: 'US' }, ...]

// Select a dataset to enable table operations
connector.useDataset('my_dataset');
// ... use tables(), peek(), find(), etc.
await connector.disconnect();
```

#### List tables

```typescript
const tables = await connector.tables();
// [{ name: 'users', schema: [...], rowCount: 1000 }, ...]
```

#### Preview rows

```typescript
const preview = await connector.peek('users', { rows: 5 });
console.log(preview.data); // Row[]
console.log(preview.columns); // ColumnInfo[] (name, type, nullable)
```

#### Conditional query with pagination

```typescript
const result = await connector.find('users', {
  where: [
    { field: 'age', operator: 'gt', value: 18 },
    { field: 'status', operator: 'eq', value: 'active' },
  ],
  orderBy: [{ field: 'name', direction: 'asc' }],
  page: { size: 20 },
});

console.log(result.data); // Row[]
console.log(result.hasMore); // boolean
console.log(result.nextCursor); // pass to next request
```

#### Raw SQL (streaming)

```typescript
for await (const row of connector.sql('SELECT name, email FROM users WHERE age > ?', [18])) {
  console.log(row);
}
```

---

## Amazon S3

**Type:** File (`FileConnector`)
**Import:** `venomous-datasource/s3`
**Peer dependencies:** `@aws-sdk/client-s3` + `@aws-sdk/credential-providers`

### Options

| Option   | Type     | Required | Description                                                  |
| -------- | -------- | -------- | ------------------------------------------------------------ |
| `bucket` | `string` | Yes      | S3 bucket name                                               |
| `prefix` | `string` | No       | Path prefix to restrict operations (e.g., `'data/uploads/'`) |
| `region` | `string` | No       | AWS region (e.g., `'us-east-1'`)                             |

### Authentication

| Type             | Fields                                     | Description                                             |
| ---------------- | ------------------------------------------ | ------------------------------------------------------- |
| `auto` (default) | —                                          | Default AWS credential chain (env vars, IAM role, etc.) |
| `access-key`     | `accessKeyId`, `secretAccessKey`, `region` | Static access key                                       |
| `profile`        | `profileName`, `region?`                   | Named AWS profile from `~/.aws/credentials`             |

### Usage

```typescript
import { createS3Connector } from 'venomous-datasource/s3';

const connector = createS3Connector({
  bucket: 'my-bucket',
  prefix: 'data/',
  region: 'ap-northeast-1',
});

// Auto auth (default)
await connector.connect();

// Or with explicit credentials
// await connector.connect({
//   type: 'access-key',
//   accessKeyId: 'AKIA_YOUR_KEY',
//   secretAccessKey: 'your-secret',
//   region: 'us-east-1',
// });
```

#### List files

```typescript
const result = await connector.files('reports/', { page: { size: 20 } });
console.log(result.data); // FileInfo[] (name, path, size, lastModified, contentType)

// Pagination
if (result.hasMore) {
  const next = await connector.files('reports/', {
    page: { size: 20, cursor: result.nextCursor },
  });
}
```

#### Preview CSV/JSON content

```typescript
const preview = await connector.peek('reports/summary.csv', { rows: 10 });
console.log(preview.data); // Row[]
```

#### Read file as stream

```typescript
const stream = await connector.read('reports/summary.csv');
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(value);
}
```

#### Get file metadata

```typescript
const info = await connector.stat('reports/summary.csv');
console.log(info.size, info.lastModified, info.contentType);
```

---

## Google Cloud Storage

**Type:** File (`FileConnector`)
**Import:** `venomous-datasource/gcs`
**Peer dependencies:** `@google-cloud/storage`

### Options

| Option      | Type     | Required | Description                                                  |
| ----------- | -------- | -------- | ------------------------------------------------------------ |
| `bucket`    | `string` | Yes      | GCS bucket name                                              |
| `prefix`    | `string` | No       | Path prefix to restrict operations (e.g., `'data/uploads/'`) |
| `projectId` | `string` | No       | GCP project ID (SDK infers from ADC if omitted)              |

### Authentication

| Type                   | Fields        | Description                               |
| ---------------------- | ------------- | ----------------------------------------- |
| `auto` (default)       | —             | Application Default Credentials (ADC)     |
| `service-account`      | `keyFilePath` | Path to service account JSON key file     |
| `service-account-json` | `credentials` | Inline service account credentials object |

### Usage

```typescript
import { createGCSConnector } from 'venomous-datasource/gcs';

const connector = createGCSConnector({
  bucket: 'my-bucket',
  prefix: 'data/',
  projectId: 'my-project',
});

// Auto auth (default)
await connector.connect();

// Or with explicit service account
// await connector.connect({
//   type: 'service-account',
//   keyFilePath: '/path/to/key.json',
// });
```

#### List files

```typescript
const result = await connector.files('reports/');
console.log(result.data); // FileInfo[] (name, path, size, lastModified, contentType)
```

#### Preview CSV/JSON content

```typescript
const preview = await connector.peek('data.csv', { rows: 10 });
console.log(preview.data); // Row[]
```

#### Read file as stream

```typescript
const stream = await connector.read('data/report.csv');
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(value);
}
```

#### Get file metadata

```typescript
const info = await connector.stat('data/report.csv');
console.log(info.size, info.lastModified, info.contentType);
```

---

## Google Sheets

**Type:** Tabular (`TabularConnector`)
**Import:** `venomous-datasource/google-sheets`
**Peer dependencies:** `googleapis`

### Options

| Option          | Type     | Required | Description                                                                      |
| --------------- | -------- | -------- | -------------------------------------------------------------------------------- |
| `spreadsheetId` | `string` | Yes      | Spreadsheet ID (from URL: `https://docs.google.com/spreadsheets/d/{id}/...`)     |
| `headerRow`     | `number` | No       | Header row number (1-based, default: 1). Set to 0 for no header (A/B/C columns) |

### Authentication

| Type                   | Fields        | Description                               |
| ---------------------- | ------------- | ----------------------------------------- |
| `auto` (default)       | —             | Application Default Credentials (ADC)     |
| `service-account`      | `keyFilePath` | Path to service account JSON key file     |
| `service-account-json` | `credentials` | Inline service account credentials object |

### Usage

```typescript
import { createSheetsConnector } from 'venomous-datasource/google-sheets';

const connector = createSheetsConnector({
  spreadsheetId: 'abc123def456...',
});

await connector.connect({
  type: 'service-account',
  keyFilePath: '/path/to/key.json',
});
```

#### List sheets

```typescript
const sheets = await connector.tables();
// [{ name: 'Sheet1', schema: [...], rowCount: 100 }, ...]
```

#### Preview rows

```typescript
const preview = await connector.peek('Sheet1', { rows: 5 });
console.log(preview.data); // Row[]
console.log(preview.columns); // ColumnInfo[] (with inferred types)
```

#### Conditional query (client-side filtering)

```typescript
const result = await connector.find('Sheet1', {
  where: [{ field: 'status', operator: 'eq', value: 'active' }],
  orderBy: [{ field: 'name', direction: 'asc' }],
  page: { size: 20 },
});
```

> Note: `find()` loads all rows from the sheet and filters in memory — Sheets API does not support server-side filtering. `sql()` is not supported and will throw `QueryError`.

#### Insert rows

```typescript
await connector.insert('Sheet1', [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
]);
```

#### Update / Delete rows

```typescript
// Update rows matching condition
await connector.update('Sheet1', {
  where: [{ field: 'name', operator: 'eq', value: 'Alice' }],
  set: { age: 31 },
});

// Delete rows matching condition
await connector.remove('Sheet1', {
  where: [{ field: 'status', operator: 'eq', value: 'inactive' }],
});
```

> Note: `update()` and `remove()` locate rows by matching conditions client-side, then update/delete by row number. Concurrent modifications may cause row number drift — use with caution on shared spreadsheets.

---

## Firebase Firestore

**Type:** Document (`DocumentConnector`)
**Import:** `venomous-datasource/firestore`
**Peer dependencies:** `firebase-admin`

> Firestore uses `DocumentConnector` — a separate interface from `TabularConnector`. Documents use `{ id, data }` model where ID is metadata, not part of the document content.

### Options

| Option       | Type     | Required | Description                                                                |
| ------------ | -------- | -------- | -------------------------------------------------------------------------- |
| `projectId`  | `string` | No       | Google Cloud project ID. Inferred from auth credentials if omitted         |
| `databaseId` | `string` | No       | Firestore database ID. Defaults to `'(default)'` (multi-database support)  |

### Authentication

| Type                   | Fields        | Description                               |
| ---------------------- | ------------- | ----------------------------------------- |
| `auto` (default)       | —             | Application Default Credentials (ADC)     |
| `service-account`      | `keyFilePath` | Path to service account JSON key file     |
| `service-account-json` | `credentials` | Inline service account credentials object |

### Usage

```typescript
import { createFirestoreConnector } from 'venomous-datasource/firestore';

const connector = createFirestoreConnector({
  projectId: 'my-project',
});

await connector.connect();
```

#### List collections

```typescript
const collections = await connector.collections();
// [{ name: 'users' }, { name: 'orders' }, ...]
```

> Only top-level collections are listed. Empty collections (no documents) are not returned — this is Firestore behavior.

#### Preview documents

```typescript
const preview = await connector.peek('users', { rows: 5 });
console.log(preview.data);   // Document[] — [{ id: 'alice', data: { name: 'Alice', age: 30 } }, ...]
console.log(preview.fields); // FieldInfo[] — inferred from sampled docs
```

> Field types are inferred from document values: `STRING`, `NUMBER`, `BOOLEAN`, `TIMESTAMP`, `GEOPOINT`, `REFERENCE`, `BYTES`, `ARRAY`, `MAP`.

#### Get document by ID

```typescript
const doc = await connector.getById('users', 'alice');
// { id: 'alice', data: { name: 'Alice', age: 30 } }
// Returns undefined if not found
```

#### Query with server-side filtering

```typescript
const result = await connector.find('users', {
  filter: [
    { field: 'age', operator: 'gt', value: 18 },
    { field: 'status', operator: 'eq', value: 'active' },
  ],
  orderBy: [{ field: 'name', direction: 'asc' }],
  page: { size: 20 },
});

console.log(result.data);       // Document[]
console.log(result.hasMore);    // boolean
console.log(result.nextCursor); // pass to next request
```

> `find()` uses Firestore server-side filtering. Complex queries may require composite indexes — Firestore returns an error with an index creation link if missing.

#### Insert documents

```typescript
const result = await connector.insert('users', [
  { id: 'bob', data: { name: 'Bob', age: 25 } },   // explicit ID
  { data: { name: 'Charlie', age: 35 } },            // auto-generated ID
]);
console.log(result.insertedIds); // ['bob', 'auto-generated-id']
```

> Document ID must not contain `/`. Documents are written in batches of 500 (Firestore limit).

#### Update / Delete documents

```typescript
// Update documents matching filter
await connector.update('users', {
  filter: [{ field: 'status', operator: 'eq', value: 'inactive' }],
  set: { status: 'archived' },
});

// Delete documents matching filter
await connector.remove('users', {
  filter: [{ field: 'status', operator: 'eq', value: 'archived' }],
});
```

> Empty filter is rejected for safety (`VENOMOUS_EMPTY_FILTER`). Uses query-then-modify pattern — for large result sets (tens of thousands+), consider batching at the application level.

#### Limitations

| Limitation     | Details |
| -------------- | ------- |
| No `sql()`     | Not part of `DocumentConnector` interface |
| No `like`      | Not in `DocFilterOperator` — Firestore has no regex/LIKE capability |
| `in` max 30    | Firestore limits `in` queries to 30 values |
| Server-side    | Complex queries may require composite indexes |

---

## MongoDB

**Type:** Document (`DocumentConnector`)
**Import:** `venomous-datasource/mongodb`
**Peer dependencies:** `mongodb`

> MongoDB uses `DocumentConnector` — the same interface as Firestore. Documents use `{ id, data }` model where ID is the `_id` field (converted to string), not part of the document content.

### Options

| Option                     | Type     | Required | Description                                          |
| -------------------------- | -------- | -------- | ---------------------------------------------------- |
| `database`                 | `string` | Yes      | Database name                                        |
| `connectTimeoutMS`         | `number` | No       | Connection timeout in ms (default: 10000)            |
| `serverSelectionTimeoutMS` | `number` | No       | Server selection timeout in ms (default: 10000)      |

### Authentication

| Type                | Fields                                                        | Description                                          |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `auto` (default)    | —                                                             | Connects to `mongodb://localhost:27017`               |
| `connection-string` | `connectionString`                                            | Full MongoDB connection string (`mongodb://` or `mongodb+srv://`) |
| `credentials`       | `username`, `password`, `host`, `port?`, `authSource?`        | Username/password with host. Credentials are URI-encoded automatically |

### Usage

```typescript
import { createMongoDBConnector } from 'venomous-datasource/mongodb';

const connector = createMongoDBConnector({
  database: 'mydb',
});

// Auto auth — connects to localhost:27017
await connector.connect();

// Or with connection string
// await connector.connect({
//   type: 'connection-string',
//   connectionString: 'mongodb+srv://user:pass@cluster.mongodb.net',
// });

// Or with explicit credentials
// await connector.connect({
//   type: 'credentials',
//   username: 'admin',
//   password: 'secret',
//   host: 'db.example.com',
//   port: 27017,
//   authSource: 'admin',
// });
```

#### List collections

```typescript
const collections = await connector.collections();
// [{ name: 'users' }, { name: 'orders' }, ...]
```

#### Preview documents

```typescript
const preview = await connector.peek('users', { rows: 5 });
console.log(preview.data);   // Document[] — [{ id: '507f...', data: { name: 'Alice', age: 30 } }, ...]
console.log(preview.fields); // FieldInfo[] — inferred from sampled docs
```

> Field types are inferred from document values: `STRING`, `NUMBER`, `BOOLEAN`, `DATE`, `OBJECTID`, `ARRAY`, `OBJECT`, `BINARY`, `NULL`.

#### Get document by ID

```typescript
const doc = await connector.getById('users', '507f1f77bcf86cd799439011');
// { id: '507f1f77bcf86cd799439011', data: { name: 'Alice', age: 30 } }
// Returns null if not found
```

#### Query with server-side filtering

```typescript
const result = await connector.find('users', {
  filter: [
    { field: 'age', operator: 'gt', value: 18 },
    { field: 'status', operator: 'eq', value: 'active' },
  ],
  orderBy: [{ field: 'name', direction: 'asc' }],
  page: { size: 20 },
});

console.log(result.data);       // Document[]
console.log(result.hasMore);    // boolean
console.log(result.nextCursor); // pass to next request
```

> `find()` uses MongoDB server-side filtering with cursor-based pagination. Cursor values are type-tagged to preserve correct comparison across `string`, `number`, `Date`, `ObjectId`, etc.

#### Insert documents

```typescript
const result = await connector.insert('users', [
  { id: 'custom-id', data: { name: 'Bob', age: 25 } },   // explicit string ID
  { data: { name: 'Charlie', age: 35 } },                  // auto-generated ObjectId
]);
console.log(result.insertedIds); // ['custom-id', '507f...']
```

> Documents are inserted in batches of 1000. Partial failures report the count of successfully inserted documents in the error message.

#### Update / Delete documents

```typescript
// Update documents matching filter
await connector.update('users', {
  filter: [{ field: 'status', operator: 'eq', value: 'inactive' }],
  set: { status: 'archived' },
});

// Delete documents matching filter
await connector.remove('users', {
  filter: [{ field: 'status', operator: 'eq', value: 'archived' }],
});
```

> Empty filter is rejected for safety. `update()` uses MongoDB `$set` operator — only specified fields are modified. Both `update()` and `remove()` operate directly on server with a single command (no query-then-modify).

#### Limitations

| Limitation     | Details |
| -------------- | ------- |
| No `sql()`     | Not part of `DocumentConnector` interface |
| No `like`      | Not in `DocFilterOperator` |
| `in` max 30    | Capped at 30 values per `in` filter |
| Cursor-based   | Pagination uses type-tagged cursor values, not offset |

---

## Azure Blob Storage

**Type:** File (`FileConnector`)
**Import:** `venomous-datasource/azure-blob-storage`
**Peer dependencies:** `@azure/storage-blob` + `@azure/identity` (for `auto` auth mode)

### Options

| Option        | Type     | Required | Description                                                                  |
| ------------- | -------- | -------- | ---------------------------------------------------------------------------- |
| `container`   | `string` | Yes      | Azure Blob container name                                                    |
| `prefix`      | `string` | No       | Path prefix to restrict operations (e.g., `'data/uploads/'`)                 |
| `accountName` | `string` | No*      | Storage account name. Required for `auto`, `sas-token`, `account-key` modes  |

> \* `accountName` is extracted automatically for `connection-string` mode.

### Authentication

| Type                | Fields                          | Description                                           |
| ------------------- | ------------------------------- | ----------------------------------------------------- |
| `auto` (default)    | —                               | DefaultAzureCredential (requires `@azure/identity`)   |
| `connection-string` | `connectionString`              | Azure Storage connection string                       |
| `sas-token`         | `accountName`, `sasToken`       | Shared Access Signature token                         |
| `account-key`       | `accountName`, `accountKey`     | Storage Account Name + Account Key                    |

### Usage

```typescript
import { createAzureBlobConnector } from 'venomous-datasource/azure-blob-storage';

const connector = createAzureBlobConnector({
  container: 'my-container',
  prefix: 'data/',
  accountName: 'mystorageaccount',
});

// Auto auth (DefaultAzureCredential)
await connector.connect();

// Or with connection string
// await connector.connect({
//   type: 'connection-string',
//   connectionString: 'DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;...',
// });
```

#### List files

```typescript
const result = await connector.files('reports/', { page: { size: 20 } });
console.log(result.data); // FileInfo[] (name, path, size, lastModified, contentType)
```

#### Preview CSV/JSON content

```typescript
const preview = await connector.peek('data/report.csv', { rows: 10 });
console.log(preview.data); // Row[]
```

#### Read file as stream

```typescript
const stream = await connector.read('data/report.csv');
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(value);
}
```

#### Get file metadata

```typescript
const info = await connector.stat('data/report.csv');
console.log(info.size, info.lastModified, info.contentType);
```
