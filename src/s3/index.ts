export type { S3Auth } from '../core/index.js';
export type { S3Options } from './types.js';
export { S3Connector } from './connector.js';

import type { FileConnector, S3Auth } from '../core/index.js';
import { S3Connector } from './connector.js';
import type { S3Options } from './types.js';

/**
 * Create an S3 connector instance.
 *
 * @param options - Connection options (bucket, prefix, region).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createS3Connector } from 'venomous-datasource/s3';
 *
 * const connector = createS3Connector({
 *   bucket: 'my-bucket',
 *   prefix: 'data/',
 *   region: 'ap-northeast-1',
 * });
 *
 * await connector.connect(); // uses default credential chain
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createS3Connector(options: S3Options): FileConnector<S3Auth> {
  return new S3Connector(options);
}
