# venomous-datasource

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](https://nodejs.org/)

Unified multi-datasource connection SDK for Node.js

One consistent API for both **tabular** (BigQuery, Google Sheets) and **file-based** (S3, GCS, Azure Blob) data sources. Zero-config auth, streaming-first (`AsyncIterable` / `ReadableStream`), path-traversal prevention, parameterized queries, credential redaction, CJK/Unicode path support, strict TypeScript types, and subpath exports — only install the SDKs you actually use.

## Supported Data Sources

| Data Source          | Type    | Import Path                      | Required Peer Dependency                                    | Status |
| -------------------- | ------- | -------------------------------- | ----------------------------------------------------------- | :----: |
| Amazon S3            | File    | `venomous-datasource/s3`         | `@aws-sdk/client-s3` + `@aws-sdk/credential-providers`      |   ✅   |
| BigQuery             | Tabular | `venomous-datasource/bigquery`   | `@google-cloud/bigquery` + `@google-cloud/resource-manager` |   ✅   |
| Google Cloud Storage | File    | `venomous-datasource/gcs`        | `@google-cloud/storage`                                     |   ✅   |
| Google Sheets        | Tabular | `venomous-datasource/google-sheets`       | `googleapis`                                                |   ✅   |
| Azure Blob Storage   | File    | `venomous-datasource/azure-blob-storage`  | `@azure/storage-blob` + `@azure/identity`                   |   ✅   |

## Installation

```bash
# Node.js >= 20.19

# Install the SDK
npm install github:BlaxBerry333/venomous-datasource#release

# Then install peer dependencies for the data sources you need:
npm install @google-cloud/bigquery @google-cloud/resource-manager   # BigQuery
npm install googleapis                                              # Google Sheets
npm install @aws-sdk/client-s3 @aws-sdk/credential-providers        # S3
npm install @google-cloud/storage                                   # GCS
npm install @azure/storage-blob @azure/identity                     # Azure Blob
```

## Quick Start

<details>
<summary>BigQuery — traditional (known project + dataset)</summary>
<br>

```typescript
import { createBigQueryConnector } from 'venomous-datasource/bigquery';

const connector = createBigQueryConnector({
  projectId: 'your-project-id',
  datasetId: 'your_dataset',
});

await connector.connect(); // Uses Application Default Credentials

const tables = await connector.tables();
const preview = await connector.peek('users', { rows: 5 });

for await (const row of connector.sql('SELECT * FROM users WHERE age > ?', [18])) {
  console.log(row);
}

await connector.disconnect();
```

</details>

<details>
<summary>BigQuery — exploration (discover projects and datasets)</summary>
<br>

```typescript
import { createBigQueryConnector } from 'venomous-datasource/bigquery';

const connector = createBigQueryConnector(); // no options needed

await connector.connect({
  type: 'service-account',
  keyFilePath: '/path/to/key.json',
});

// Discover available resources
const projects = await connector.projects();
const datasets = await connector.datasets();

// Select a dataset, then use tables/peek/find/sql as usual
connector.useDataset(datasets[0].datasetId);
const tables = await connector.tables();

await connector.disconnect();
```

</details>

<details>
<summary>Amazon S3</summary>
<br>

```typescript
import { createS3Connector } from 'venomous-datasource/s3';

const connector = createS3Connector({
  bucket: 'your-bucket',
  prefix: 'data/',
  region: 'ap-northeast-1',
});

// Uses default AWS credential chain (env vars, IAM role, etc.)
await connector.connect();

// List files with pagination
const files = await connector.files('reports/', { page: { size: 20 } });

// Read file as a ReadableStream
const stream = await connector.read('reports/summary.csv');

// Get file metadata (size, lastModified, contentType)
const info = await connector.stat('reports/summary.csv');

await connector.disconnect();
```

</details>

<details>
<summary>Google Sheets</summary>
<br>

```typescript
import { createSheetsConnector } from 'venomous-datasource/google-sheets';

const connector = createSheetsConnector({
  spreadsheetId: 'abc123def456...',
});

await connector.connect({
  type: 'service-account',
  keyFilePath: '/path/to/key.json',
});

// List all sheets in the spreadsheet
const sheets = await connector.tables();

// Preview first 5 rows of a sheet
const preview = await connector.peek(sheets[0].name, { rows: 5 });

// Insert rows
await connector.insert('Sheet1', [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
]);

await connector.disconnect();
```

</details>

<details>
<summary>Google Cloud Storage</summary>
<br>

```typescript
import { createGCSConnector } from 'venomous-datasource/gcs';

const connector = createGCSConnector({
  bucket: 'your-bucket',
  prefix: 'data/',
  projectId: 'your-project',
});

// Uses Application Default Credentials by default
await connector.connect();

// List files in a directory
const files = await connector.files('reports/');

// Preview first 10 rows of a CSV/JSON file
const preview = await connector.peek('data.csv', { rows: 10 });

await connector.disconnect();
```

</details>

<details>
<summary>Azure Blob Storage</summary>
<br>

```typescript
import { createAzureBlobConnector } from 'venomous-datasource/azure-blob-storage';

const connector = createAzureBlobConnector({
  container: 'my-container',
  prefix: 'data/',
  accountName: 'mystorageaccount',
});

await connector.connect(); // Uses DefaultAzureCredential

const files = await connector.files('reports/');
const preview = await connector.peek('data/report.csv', { rows: 10 });
const stream = await connector.read('data/report.csv');

await connector.disconnect();
```

</details>

## Documentation

| Document                                    | Description                                                   |
| ------------------------------------------- | ------------------------------------------------------------- |
| [Connector Guide](documents/connectors.md)  | Detailed usage for each data source (options, auth, examples) |
| [API Reference](documents/api-reference.md) | Core interfaces, types, error classes, utility functions      |
| [Extending](documents/extending.md)         | How to build a custom connector                               |
| [Development](documents/development.md)     | Project structure and development commands                    |

## License

[MIT](LICENSE)
