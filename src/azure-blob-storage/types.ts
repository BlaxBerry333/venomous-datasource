/**
 * Azure Blob Storage connector connection options.
 */
export interface AzureBlobStorageOptions {
  /** Azure Blob container name. */
  readonly container: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /**
   * Azure Storage account name.
   * Required for `sas-token` auth mode.
   * For `connection-string` mode, the account name is extracted from the connection string.
   */
  readonly accountName?: string;
}
