import { BlobServiceClient } from '@azure/storage-blob';
import type { AzureBlobStorageAuth } from '../core/index.js';
import { AuthenticationError } from '../core/index.js';

const CONNECTOR_NAME = 'azure-blob-storage';

/**
 * Build the Azure Blob Storage endpoint URL from an account name.
 */
function buildAccountUrl(accountName: string): string {
  return `https://${accountName}.blob.core.windows.net`;
}

/**
 * Resolve an AzureBlobStorageAuth configuration into a BlobServiceClient.
 *
 * Azure SDK's BlobServiceClient construction varies significantly by auth type,
 * so this function returns the fully constructed client.
 *
 * @param auth - Auth configuration. Must be provided explicitly.
 * @returns Object containing the constructed BlobServiceClient.
 * @throws {AuthenticationError} When auth is undefined.
 */
export async function resolveAuth(
  auth: AzureBlobStorageAuth | undefined
): Promise<{ client: BlobServiceClient }> {
  if (!auth) {
    throw new AuthenticationError(
      "Authentication is required. Provide { type: 'connection-string', connectionString } or { type: 'sas-token', accountName, sasToken }.",
      { code: 'VENOMOUS_AUTH_REQUIRED', connector: CONNECTOR_NAME }
    );
  }

  if (auth.type === 'connection-string') {
    const client = BlobServiceClient.fromConnectionString(auth.connectionString);
    return { client };
  }

  if (auth.type === 'sas-token') {
    const token = auth.sasToken.replace(/^\?/, '');
    const url = `${buildAccountUrl(auth.accountName)}?${token}`;
    const client = new BlobServiceClient(url);
    return { client };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
