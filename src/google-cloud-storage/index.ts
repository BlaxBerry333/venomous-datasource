export type { GoogleCloudStorageAuth } from '../core/index.js';
export type { GoogleCloudStorageOptions } from './types.js';
export { GoogleCloudStorageConnector } from './connector.js';

import type { FileConnector, GoogleCloudStorageAuth } from '../core/index.js';
import { GoogleCloudStorageConnector } from './connector.js';
import type { GoogleCloudStorageOptions } from './types.js';

/**
 * Create a Google Cloud Storage connector instance.
 *
 * Google Cloud Storage requires explicit credentials — `connect()` without
 * auth will throw `AuthenticationError`.
 *
 * @param options - Connection options (bucket, prefix, projectId).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createGoogleCloudStorageConnector } from 'venomous-datasource/google-cloud-storage';
 *
 * const connector = createGoogleCloudStorageConnector({
 *   bucket: 'my-bucket',
 *   prefix: 'data/',
 *   projectId: 'my-project',
 * });
 *
 * await connector.connect({ credentials: serviceAccountJson });
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createGoogleCloudStorageConnector(
  options: GoogleCloudStorageOptions
): FileConnector<GoogleCloudStorageAuth> {
  return new GoogleCloudStorageConnector(options);
}
