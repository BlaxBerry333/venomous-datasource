/**
 * Azure Blob Storage connector connection options.
 */
export interface AzureBlobOptions {
  /** Azure Blob container name. */
  readonly container: string;
  /** Optional path prefix to restrict operations (e.g., "data/uploads/"). */
  readonly prefix?: string;
  /**
   * Azure Storage account name.
   * Required for `auto`, `sas-token`, and `account-key` auth modes.
   * For `connection-string` mode, the account name is extracted from the connection string.
   */
  readonly accountName?: string;
}
