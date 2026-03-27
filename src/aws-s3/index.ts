export type { AWSS3Auth } from '../core/index.js';
export type { AWSS3Options } from './types.js';
export { AWSS3Connector } from './connector.js';

import type { FileConnector, AWSS3Auth } from '../core/index.js';
import { AWSS3Connector } from './connector.js';
import type { AWSS3Options } from './types.js';

/**
 * Create an AWS S3 connector instance.
 *
 * @param options - Connection options (bucket, prefix, region).
 * @returns An unconnected FileConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createAWSS3Connector } from 'venomous-datasource/aws-s3';
 *
 * const connector = createAWSS3Connector({
 *   bucket: 'my-bucket',
 *   prefix: 'data/',
 * });
 *
 * // AWS S3 requires explicit credentials
 * await connector.connect({
 *   accessKeyId: 'AKIA...',
 *   secretAccessKey: '...',
 *   region: 'ap-northeast-1',
 * });
 * const files = await connector.files('reports/');
 * await connector.disconnect();
 * ```
 */
export function createAWSS3Connector(options: AWSS3Options): FileConnector<AWSS3Auth> {
  return new AWSS3Connector(options);
}
