import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import type { S3Auth } from '../core/index.js';

/**
 * Resolve an S3Auth configuration into S3Client SDK options.
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @param defaultRegion - Fallback region when not specified in auth.
 * @returns S3Client configuration object.
 *
 * @example
 * ```typescript
 * const config = resolveAuth({ type: 'auto' });
 * // {} -- SDK uses default credential chain (env vars -> config file -> IAM role)
 *
 * const config2 = resolveAuth({
 *   type: 'access-key',
 *   accessKeyId: 'AKIA...',
 *   secretAccessKey: '...',
 *   region: 'us-east-1',
 * });
 * // { credentials: { accessKeyId: '...', secretAccessKey: '...' }, region: 'us-east-1' }
 * ```
 */
export function resolveAuth(auth?: S3Auth, defaultRegion?: string): S3ClientConfig {
  if (!auth || auth.type === 'auto') {
    return defaultRegion ? { region: defaultRegion } : {};
  }

  if (auth.type === 'access-key') {
    return {
      credentials: {
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
      },
      region: auth.region,
    };
  }

  if (auth.type === 'profile') {
    return {
      credentials: fromIni({ profile: auth.profileName }),
      region: auth.region ?? defaultRegion,
    };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
