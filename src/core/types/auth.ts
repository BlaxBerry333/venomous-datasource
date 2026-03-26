/**
 * BigQuery authentication options.
 *
 * BigQuery requires explicit authentication — `auto` (ADC) is not supported.
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type BigQueryAuth = {
  readonly type?: 'credentials';
  readonly credentials: object;
};

/**
 * GCS authentication options (discriminated union).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type GCSAuth =
  | { readonly type: 'auto' }
  | { readonly type?: 'credentials'; readonly credentials: object };

/**
 * Google Sheets authentication options (discriminated union).
 * Same auth modes as GCS (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type SheetsAuth =
  | { readonly type: 'auto' }
  | { readonly type?: 'credentials'; readonly credentials: object };

/**
 * Firebase Firestore authentication options (discriminated union).
 * Same auth modes as BigQuery/GCS/Sheets (Google service account based).
 * The `type` field can be omitted (defaults to `'credentials'`).
 */
export type FirestoreAuth =
  | { readonly type: 'auto' }
  | { readonly type?: 'credentials'; readonly credentials: object };

/**
 * S3 authentication options (discriminated union).
 */
export type S3Auth =
  | { readonly type: 'auto' }
  | {
      readonly type: 'access-key';
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly region: string;
    }
  | { readonly type: 'profile'; readonly profileName: string; readonly region?: string };

/**
 * Azure Blob Storage authentication options (discriminated union).
 */
export type AzureBlobAuth =
  | { readonly type: 'auto' }
  | { readonly type: 'connection-string'; readonly connectionString: string }
  | { readonly type: 'sas-token'; readonly accountName: string; readonly sasToken: string }
  | { readonly type: 'account-key'; readonly accountName: string; readonly accountKey: string };

/**
 * MongoDB authentication options (discriminated union).
 *
 * Three modes:
 * - `auto`: Connect to `mongodb://localhost:27017` without authentication (local dev).
 * - `connection-string`: User provides a full MongoDB URI (`mongodb://` or `mongodb+srv://`).
 * - `credentials`: User provides username/password/host, program constructs the URI.
 */
export type MongoDBAuth =
  | { readonly type: 'auto' }
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
export type FileAuth = S3Auth | GCSAuth | AzureBlobAuth;

/**
 * Union of all document data source auth types.
 */
export type DocumentAuth = FirestoreAuth | MongoDBAuth;
