export type { AzureBlobStorageAuth } from '../core/index.js';
export type { AzureBlobStorageOptions } from './types.js';
export { AzureBlobStorageConnector } from './connector.js';

import type { FileConnector, AzureBlobStorageAuth } from '../core/index.js';
import { AzureBlobStorageConnector } from './connector.js';
import type { AzureBlobStorageOptions } from './types.js';

/**
 * Create an Azure Blob Storage connector instance.
 *
 * @param options - Connection options (container, prefix, accountName).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createAzureBlobStorageConnector } from 'venomous-datasource/azure-blob-storage';
 *
 * const connector = createAzureBlobStorageConnector({
 *   container: 'my-container',
 *   prefix: 'data/',
 * });
 *
 * await connector.connect({ type: 'connection-string', connectionString: '...' });
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createAzureBlobStorageConnector(
  options: AzureBlobStorageOptions
): FileConnector<AzureBlobStorageAuth> {
  return new AzureBlobStorageConnector(options);
}
