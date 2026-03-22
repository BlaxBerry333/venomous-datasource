export type { GCSAuth } from '../core/index.js';
export type { GCSOptions } from './types.js';
export { GCSConnector } from './connector.js';

import type { FileConnector, GCSAuth } from '../core/index.js';
import { GCSConnector } from './connector.js';
import type { GCSOptions } from './types.js';

/**
 * Create a GCS connector instance.
 *
 * @param options - Connection options (bucket, prefix, projectId).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createGCSConnector } from 'venomous-datasource/gcs';
 *
 * const connector = createGCSConnector({
 *   bucket: 'my-bucket',
 *   prefix: 'data/',
 *   projectId: 'my-project',
 * });
 *
 * await connector.connect(); // uses Application Default Credentials
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createGCSConnector(options: GCSOptions): FileConnector<GCSAuth> {
  return new GCSConnector(options);
}
