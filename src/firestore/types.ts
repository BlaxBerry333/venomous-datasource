/**
 * Options for creating a Firestore connector.
 */
export interface FirestoreOptions {
  /** GCP project ID. Can be inferred from service account credentials. */
  readonly projectId?: string;
  /** Firestore database ID. Defaults to `'(default)'`. */
  readonly databaseId?: string;
}
