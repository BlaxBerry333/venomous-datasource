import type { StorageOptions } from '@google-cloud/storage';
import type { GoogleCloudStorageAuth } from '../core/index.js';

/**
 * Resolve a GoogleCloudStorageAuth configuration into Google Cloud Storage SDK options.
 *
 * @param auth - Auth configuration (credentials required).
 * @param projectId - Optional GCP project ID override.
 * @returns StorageOptions for the Storage constructor.
 *
 * @example
 * ```typescript
 * const config = resolveAuth({ credentials: {...} });
 * // { credentials: {...} }
 *
 * const config2 = resolveAuth({ credentials: {...} }, 'my-project');
 * // { projectId: 'my-project', credentials: {...} }
 * ```
 */
export function resolveAuth(auth: GoogleCloudStorageAuth, projectId?: string): StorageOptions {
  const base: StorageOptions = {};
  if (projectId) {
    base.projectId = projectId;
  }

  return {
    ...base,
    credentials: auth.credentials as Record<string, string>,
  };
}
