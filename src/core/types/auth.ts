/**
 * Base authentication type.
 * Delegates to the native SDK's default credential chain.
 */
export interface BaseAuth {
  readonly type: 'auto';
}

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
 * S3 authentication options (discriminated union).
 */
export type S3Auth =
  | BaseAuth
  | {
      readonly type: 'access-key';
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly region: string;
    }
  | { readonly type: 'profile'; readonly profileName: string; readonly region?: string };

/**
 * GCS authentication options (discriminated union).
 */
export type GCSAuth =
  | BaseAuth
  | { readonly type: 'service-account-json'; readonly credentials: object };

/**
 * Google Sheets authentication options (discriminated union).
 * Same auth modes as GCS (Google service account based).
 */
export type SheetsAuth =
  | BaseAuth
  | { readonly type: 'service-account-json'; readonly credentials: object };

/**
 * Union of all tabular data source auth types.
 */
export type TabularAuth = BigQueryAuth | SheetsAuth;

/**
 * Azure Blob Storage authentication options (discriminated union).
 */
export type AzureBlobAuth =
  | BaseAuth
  | { readonly type: 'connection-string'; readonly connectionString: string }
  | { readonly type: 'sas-token'; readonly accountName: string; readonly sasToken: string }
  | { readonly type: 'account-key'; readonly accountName: string; readonly accountKey: string };

/**
 * Union of all file data source auth types.
 */
export type FileAuth = S3Auth | GCSAuth | AzureBlobAuth;

/**
 * Firebase Firestore authentication options (discriminated union).
 * Same auth modes as BigQuery/GCS/Sheets (Google service account based).
 */
export type FirestoreAuth =
  | BaseAuth
  | { readonly type: 'service-account-json'; readonly credentials: object };

/**
 * MongoDB authentication options (discriminated union).
 *
 * Three modes:
 * - `auto`: Connect to `mongodb://localhost:27017` without authentication (local dev).
 * - `connection-string`: User provides a full MongoDB URI (`mongodb://` or `mongodb+srv://`).
 * - `credentials`: User provides username/password/host, program constructs the URI.
 */
export type MongoDBAuth =
  | BaseAuth
  | { readonly type: 'connection-string'; readonly connectionString: string }
  | {
      readonly type: 'credentials';
      readonly username: string;
      readonly password: string;
      readonly host: string;
      readonly port?: number;
      readonly authSource?: string;
    };

/**
 * Union of all document data source auth types.
 */
export type DocumentAuth = FirestoreAuth | MongoDBAuth;
