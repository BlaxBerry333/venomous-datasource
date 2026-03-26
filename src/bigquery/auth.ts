import type { BigQueryAuth } from '../core/index.js';
import type { BigQueryOptions as SDKOptions } from '@google-cloud/bigquery';

/**
 * Resolve a BigQueryAuth config into SDK client options.
 *
 * @param auth - Auth configuration. `type` can be omitted (defaults to `'credentials'`).
 * @returns BigQuery SDK options suitable for `new BigQuery(options)`.
 *
 * @example
 * ```typescript
 * const opts = resolveAuth({ credentials: {...} });
 * // { credentials: {...} }
 * ```
 */
export function resolveAuth(auth: BigQueryAuth): SDKOptions {
  if (!auth.type || auth.type === 'credentials') {
    return { credentials: auth.credentials as SDKOptions['credentials'] };
  }

  // Runtime guard for unknown auth types (bypassing TypeScript via `as any`).
  throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}

/**
 * Extract project_id from auth config, if available.
 *
 * Extracts `project_id` from the credentials object.
 * Empty strings are treated as unavailable (returns `undefined`).
 *
 * @param auth - Auth configuration. `type` can be omitted (defaults to `'credentials'`).
 * @returns The project_id string, or undefined if not available.
 *
 * @example
 * ```typescript
 * const projectId = resolveProjectId({ credentials: { project_id: 'my-project' } });
 * // 'my-project'
 * ```
 */
export function resolveProjectId(auth: BigQueryAuth): string | undefined {
  if (!auth.type || auth.type === 'credentials') {
    return (auth.credentials as { project_id?: string }).project_id || undefined;
  }

  // Runtime guard for unknown auth types (bypassing TypeScript via `as any`).
  throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}
