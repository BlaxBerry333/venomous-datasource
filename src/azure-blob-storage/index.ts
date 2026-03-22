export type { AzureBlobAuth } from '../core/index.js';
export type { AzureBlobOptions } from './types.js';
export { AzureBlobConnector } from './connector.js';

import type { FileConnector, AzureBlobAuth } from '../core/index.js';
import { AzureBlobConnector } from './connector.js';
import type { AzureBlobOptions } from './types.js';

/**
 * Create an Azure Blob Storage connector instance.
 *
 * @param options - Connection options (container, prefix, accountName).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createAzureBlobConnector } from 'venomous-datasource/azure-blob-storage';
 *
 * const connector = createAzureBlobConnector({
 *   container: 'my-container',
 *   prefix: 'data/',
 *   accountName: 'mystorageaccount',
 * });
 *
 * await connector.connect(); // uses DefaultAzureCredential
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createAzureBlobConnector(options: AzureBlobOptions): FileConnector<AzureBlobAuth> {
  return new AzureBlobConnector(options);
}
