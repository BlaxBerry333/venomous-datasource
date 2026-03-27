import { normalizePath } from '../core/index.js';

/**
 * Convert a user-facing path to an Azure Blob name.
 *
 * Azure Blob Storage natively supports UTF-8 blob names, so NO percent-encoding
 * is applied. Only NFC normalization (via `normalizePath`) is performed.
 * Logic is identical to Google Cloud Storage path handling.
 *
 * @param userPath - User-provided relative path.
 * @param prefix - Optional container prefix (e.g., "data/uploads").
 * @returns Blob name suitable for SDK calls.
 *
 * @example
 * ```typescript
 * toBlobPath('reports/月次.csv', 'data');
 * // 'data/reports/月次.csv'
 * ```
 */
export function toBlobPath(userPath: string | undefined, prefix?: string): string {
  const normalizedPrefix = prefix ? stripSlashes(prefix) : '';

  if (userPath === undefined || userPath === null || userPath.trim() === '') {
    return normalizedPrefix ? `${normalizedPrefix}/` : '';
  }

  const safe = normalizePath(userPath);

  if (normalizedPrefix) {
    return `${normalizedPrefix}/${safe}`;
  }
  return safe;
}

/**
 * Convert an Azure Blob name back to a user-facing path.
 *
 * @param blobName - Blob name from SDK response.
 * @param prefix - Optional container prefix to strip.
 * @returns User-facing path with original Unicode characters preserved.
 *
 * @example
 * ```typescript
 * fromBlobPath('data/reports/月次.csv', 'data');
 * // 'reports/月次.csv'
 * ```
 */
export function fromBlobPath(blobName: string, prefix?: string): string {
  // NFC normalize first, before prefix matching, to handle potential NFD keys.
  let relative = blobName.normalize('NFC');
  const normalizedPrefix = prefix ? stripSlashes(prefix).normalize('NFC') : '';

  if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) {
    relative = relative.slice(normalizedPrefix.length + 1);
  } else if (normalizedPrefix && relative === normalizedPrefix) {
    relative = '';
  }

  // Strip trailing slashes (directory markers)
  relative = relative.replace(/\/+$/, '');

  return relative;
}

/**
 * Build a directory prefix for Azure Blob listing.
 * Ensures the prefix ends with '/' for directory scoping.
 *
 * @param userPath - User-provided directory path (optional).
 * @param prefix - Container-level prefix (optional).
 * @returns Blob prefix string ending with '/' for directory listing.
 */
export function toBlobPrefix(userPath: string | undefined, prefix?: string): string {
  const path = toBlobPath(userPath, prefix);
  if (path === '') {
    return '';
  }
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * Strip leading and trailing slashes from a string.
 */
function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}
