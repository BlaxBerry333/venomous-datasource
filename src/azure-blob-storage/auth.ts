import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { AzureBlobAuth } from '../core/index.js';
import { ConnectionError } from '../core/index.js';

const CONNECTOR_NAME = 'azure-blob-storage';

/**
 * Build the Azure Blob Storage endpoint URL from an account name.
 */
function buildAccountUrl(accountName: string): string {
  return `https://${accountName}.blob.core.windows.net`;
}

/**
 * Resolve an AzureBlobAuth configuration into a BlobServiceClient.
 *
 * Unlike S3/GCS where resolveAuth returns SDK config objects, Azure SDK's
 * BlobServiceClient construction varies significantly by auth type, so this
 * function returns the fully constructed client.
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @param accountName - Optional account name from connector options.
 * @returns Object containing the constructed BlobServiceClient.
 *
 * @remarks `@azure/identity` is dynamically imported only when using `auto` mode,
 * since it is an optional peerDependency.
 */
export async function resolveAuth(
  auth: AzureBlobAuth | undefined,
  accountName?: string
): Promise<{ client: BlobServiceClient }> {
  if (!auth || auth.type === 'auto') {
    const resolvedAccount = accountName;
    if (!resolvedAccount) {
      throw new ConnectionError(
        'accountName is required for auto auth mode. Provide it in connector options or use connection-string mode.',
        { code: 'VENOMOUS_INVALID_OPTIONS', connector: CONNECTOR_NAME }
      );
    }

    const { DefaultAzureCredential } = await import('@azure/identity');
    const client = new BlobServiceClient(
      buildAccountUrl(resolvedAccount),
      new DefaultAzureCredential()
    );
    return { client };
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

  if (auth.type === 'account-key') {
    const credential = new StorageSharedKeyCredential(auth.accountName, auth.accountKey);
    const client = new BlobServiceClient(buildAccountUrl(auth.accountName), credential);
    return { client };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
