import { readFileSync } from 'node:fs';
import type { BigQueryAuth } from '../core/index.js';
import type { BigQueryOptions as SDKOptions } from '@google-cloud/bigquery';

/**
 * Resolve a BigQueryAuth config into SDK client options.
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @returns BigQuery SDK options suitable for `new BigQuery(options)`.
 *
 * @example
 * ```typescript
 * const opts = resolveAuth({ type: 'auto' });
 * // {}  -- SDK uses Application Default Credentials
 *
 * const opts2 = resolveAuth({ type: 'service-account', keyFilePath: '/path/to/key.json' });
 * // { keyFilename: '/path/to/key.json' }
 * ```
 */
export function resolveAuth(auth?: BigQueryAuth): SDKOptions {
  if (!auth || auth.type === 'auto') {
    return {};
  }

  if (auth.type === 'service-account') {
    return { keyFilename: auth.keyFilePath };
  }

  if (auth.type === 'service-account-json') {
    return { credentials: auth.credentials as SDKOptions['credentials'] };
  }

  // Exhaustive check: if we reach here, the auth type is unknown
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}

/**
 * Extract project_id from auth config, if available.
 *
 * Returns `undefined` for `auto` mode (SDK will determine projectId internally).
 * For `service-account`, reads the key file synchronously and extracts `project_id`.
 * For `service-account-json`, extracts `project_id` from the credentials object.
 * Empty strings are treated as unavailable (returns `undefined`).
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @returns The project_id string, or undefined if not available.
 * @throws If the key file cannot be read or parsed (errors propagate naturally).
 *
 * @example
 * ```typescript
 * const projectId = resolveProjectId({ type: 'service-account', keyFilePath: '/path/to/key.json' });
 * // 'my-project-123' (from key file's project_id field)
 *
 * const projectId2 = resolveProjectId({ type: 'auto' });
 * // undefined (SDK will determine projectId)
 * ```
 */
export function resolveProjectId(auth?: BigQueryAuth): string | undefined {
  if (!auth || auth.type === 'auto') {
    return undefined;
  }

  if (auth.type === 'service-account') {
    const raw = readFileSync(auth.keyFilePath, 'utf-8');
    const keyFile = JSON.parse(raw) as { project_id?: string };
    return keyFile.project_id || undefined;
  }

  if (auth.type === 'service-account-json') {
    return (auth.credentials as { project_id?: string }).project_id || undefined;
  }

  // Exhaustive check
  const _exhaustiveProjectId: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustiveProjectId)}`);
}
