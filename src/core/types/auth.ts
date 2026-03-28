/**
 * BigQuery authentication options.
 *
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type BigQueryAuth = {
  readonly type?: 'credentials';
  readonly credentials: object;
};

/**
 * Google Cloud Storage authentication options.
 *
 * Auto auth is not supported — explicit credentials are required.
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type GoogleCloudStorageAuth = {
  readonly type?: 'credentials';
  readonly credentials: object;
};

/**
 * Google Sheets authentication options (discriminated union).
 * Same auth modes as Google Cloud Storage (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type SheetsAuth =
  | { readonly type: 'auto' }
  | { readonly type?: 'credentials'; readonly credentials: object };

/**
 * Firebase Firestore authentication options (discriminated union).
 * Same auth modes as BigQuery/Google Cloud Storage/Sheets (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type FirestoreAuth =
  | { readonly type: 'auto' }
  | { readonly type?: 'credentials'; readonly credentials: object };

/**
 * AWS S3 authentication options.
 *
 * The `type` field can be omitted (defaults to `'access-key'`).
 */
export type AWSS3Auth = {
  readonly type?: 'access-key';
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
};

/**
 * Azure Blob Storage authentication options (discriminated union).
 */
export type AzureBlobStorageAuth =
  | { readonly type: 'connection-string'; readonly connectionString: string }
  | { readonly type: 'sas-token'; readonly accountName: string; readonly sasToken: string };

/**
 * MongoDB authentication options (discriminated union).
 *
 * Two modes:
 * - `connection-string`: User provides a full MongoDB URI (`mongodb://` or `mongodb+srv://`).
 * - `credentials`: User provides username/password/host, program constructs the URI.
 *
 * When omitted (`undefined`), connects to `mongodb://localhost:27017` (local dev).
 */
export type MongoDBAuth =
  | { readonly type: 'connection-string'; readonly connectionString: string }
  | {
      readonly type: 'credentials';
      readonly username: string;
      readonly password: string;
      readonly host: string;
      readonly port?: number;
      readonly authSource?: string;
    };

// ── Union Types ───────────────────────────────────────────────

/**
 * Union of all tabular data source auth types.
 */
export type TabularAuth = BigQueryAuth | SheetsAuth;

/**
 * Union of all file data source auth types.
 */
export type FileAuth = AWSS3Auth | GoogleCloudStorageAuth | AzureBlobStorageAuth;

/**
 * Union of all document data source auth types.
 */
export type DocumentAuth = FirestoreAuth | MongoDBAuth;
