import type { S3ClientConfig } from '@aws-sdk/client-s3';
import type { AWSS3Auth } from '../core/index.js';

/**
 * Resolve an AWSS3Auth configuration into S3Client SDK options.
 *
 * The `type` field can be omitted (defaults to `'access-key'`).
 *
 * @param auth - Auth configuration (required, must contain accessKeyId/secretAccessKey/region).
 * @returns S3Client configuration object.
 *
 * @example
 * ```typescript
 * const config = resolveAuth({
 *   accessKeyId: 'AKIA...',
 *   secretAccessKey: '...',
 *   region: 'us-east-1',
 * });
 * // { credentials: { accessKeyId: '...', secretAccessKey: '...' }, region: 'us-east-1' }
 *
 * // type can also be explicitly provided:
 * const config2 = resolveAuth({
 *   type: 'access-key',
 *   accessKeyId: 'AKIA...',
 *   secretAccessKey: '...',
 *   region: 'us-east-1',
 * });
 * ```
 */
export function resolveAuth(auth: AWSS3Auth): S3ClientConfig {
  return {
    credentials: {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
    },
    region: auth.region,
  };
}
