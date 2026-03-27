# Development

## Project Structure

```
src/
├── core/                # Shared foundation (venomous-datasource/core)
│   ├── index.ts         # Subpath entry — re-exports all public API
│   ├── interfaces/      # TabularConnector, FileConnector, DocumentConnector
│   ├── types/           # Auth, pagination, query, result types
│   ├── errors/          # VenomousError and subclasses
│   └── utils/           # Path, sanitize, pagination, CSV/JSON parser utilities
├── bigquery/            # BigQuery connector (venomous-datasource/bigquery)
│   ├── index.ts         # Subpath entry — exports createBigQueryConnector
│   ├── connector.ts     # TabularConnector implementation
│   ├── auth.ts          # Auth resolution + resolveProjectId
│   └── types.ts         # BigQueryOptions, ProjectInfo, DatasetInfo
├── aws-s3/              # AWS S3 connector (venomous-datasource/aws-s3)
│   ├── index.ts         # Subpath entry — exports createAWSS3Connector
│   ├── connector.ts     # FileConnector implementation
│   ├── auth.ts          # Auth resolution
│   ├── path.ts          # S3 path utilities
│   └── types.ts         # AWSS3Options
├── google-cloud-storage/ # Google Cloud Storage connector (venomous-datasource/google-cloud-storage)
│   ├── index.ts         # Subpath entry — exports createGoogleCloudStorageConnector
│   ├── connector.ts     # FileConnector implementation
│   ├── auth.ts          # Auth resolution
│   ├── path.ts          # Google Cloud Storage path utilities
│   └── types.ts         # GoogleCloudStorageOptions
├── google-sheets/       # Google Sheets connector (venomous-datasource/google-sheets)
│   ├── index.ts         # Subpath entry — exports createSheetsConnector
│   ├── connector.ts     # TabularConnector implementation
│   ├── auth.ts          # Auth resolution
│   └── types.ts         # SheetsOptions
├── firestore/           # Firestore connector (venomous-datasource/firestore)
│   ├── index.ts         # Subpath entry — exports createFirestoreConnector
│   ├── connector.ts     # DocumentConnector implementation
│   ├── auth.ts          # Auth resolution (async, dynamic import for firebase-admin)
│   └── types.ts         # FirestoreOptions
└── azure-blob-storage/  # Azure Blob connector (venomous-datasource/azure-blob-storage)
    ├── index.ts         # Subpath entry — exports createAzureBlobStorageConnector
    ├── connector.ts     # FileConnector implementation
    ├── auth.ts          # Auth resolution (connection-string, sas-token)
    ├── path.ts          # Azure Blob path utilities
    └── types.ts         # AzureBlobStorageOptions
```

Each connector is a subpath export (`venomous-datasource/bigquery`, etc.) with its own peer dependency, so users only install what they use.

## Commands

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `npm run build`         | Build all modules (tsdown)                         |
| `npm test`              | Run tests with coverage (vitest)                   |
| `npm run lint`          | Lint source files (eslint)                         |
| `npm run lint:fix`      | Lint and auto-fix                                  |
| `npm run format`        | Format source files (prettier)                     |
| `npm run format:check`  | Check formatting without writing                   |
| `npm run check:type`    | Type-check without emitting (tsc --noEmit)         |
| `npm run check`         | Run format check + lint + type check (all at once) |

## Tech Stack

- **Runtime:** Node.js >= 20.19
- **Language:** TypeScript 5.5+
- **Build:** tsdown
- **Test:** vitest
- **Lint:** eslint 9 + @typescript-eslint
- **Format:** prettier
