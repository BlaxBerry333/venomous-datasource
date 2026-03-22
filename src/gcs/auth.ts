import type { StorageOptions } from '@google-cloud/storage';
import type { GCSAuth } from '../core/index.js';

/**
 * Resolve a GCSAuth configuration into Google Cloud Storage SDK options.
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @param projectId - Optional GCP project ID override.
 * @returns StorageOptions for the Storage constructor.
 *
 * @example
 * ```typescript
 * const config = resolveAuth({ type: 'auto' });
 * // {} -- SDK uses Application Default Credentials (ADC)
 *
 * const config2 = resolveAuth({
 *   type: 'service-account',
 *   keyFilePath: '/path/to/key.json',
 * });
 * // { keyFilename: '/path/to/key.json' }
 * ```
 */
export function resolveAuth(auth?: GCSAuth, projectId?: string): StorageOptions {
  const base: StorageOptions = {};
  if (projectId) {
    base.projectId = projectId;
  }

  if (!auth || auth.type === 'auto') {
    return base;
  }

  if (auth.type === 'service-account') {
    return {
      ...base,
      keyFilename: auth.keyFilePath,
    };
  }

  if (auth.type === 'service-account-json') {
    return {
      ...base,
      credentials: auth.credentials as Record<string, string>,
    };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
