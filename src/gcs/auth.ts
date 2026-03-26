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
 * const config2 = resolveAuth({ credentials: {...} });
 * // { credentials: {...} }
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

  if (!auth.type || auth.type === 'credentials') {
    return {
      ...base,
      credentials: auth.credentials as Record<string, string>,
    };
  }

  // Exhaustive check (`const _exhaustive: never = auth`) is not possible here
  // because `type` is optional — TypeScript cannot narrow an optional discriminant.
  // This throw is a runtime guard for unknown auth types (e.g. bypassing via `as any`).
  throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}
