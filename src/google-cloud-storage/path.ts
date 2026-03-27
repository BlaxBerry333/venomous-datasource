import { normalizePath } from '../core/index.js';

/**
 * Convert a user-facing path to a Google Cloud Storage object name.
 *
 * Unlike S3, Google Cloud Storage natively supports UTF-8 keys, so NO percent-encoding is applied.
 * Only NFC normalization (via `normalizePath`) is performed.
 *
 * @param userPath - User-provided relative path.
 * @param prefix - Optional bucket prefix (e.g., "data/uploads").
 * @returns Google Cloud Storage object name suitable for SDK calls.
 *
 * @example
 * ```typescript
 * toGoogleCloudStoragePath('reports/月次.csv', 'data');
 * // 'data/reports/月次.csv'  (no percent-encoding, unlike S3)
 * ```
 */
export function toGoogleCloudStoragePath(userPath: string | undefined, prefix?: string): string {
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
 * Convert a Google Cloud Storage object name back to a user-facing path.
 *
 * @param googleCloudStoragePath - Google Cloud Storage object name from SDK response.
 * @param prefix - Optional bucket prefix to strip.
 * @returns User-facing path with original Unicode characters preserved.
 *
 * @example
 * ```typescript
 * fromGoogleCloudStoragePath('data/reports/月次.csv', 'data');
 * // 'reports/月次.csv'
 * ```
 */
export function fromGoogleCloudStoragePath(
  googleCloudStoragePath: string,
  prefix?: string
): string {
  // NFC normalize first, before prefix matching, to handle potential NFD keys
  // from macOS uploads. If Google Cloud Storage returns NFD and prefix is NFC,
  // startsWith would fail without pre-normalization.
  let relative = googleCloudStoragePath.normalize('NFC');
  const normalizedPrefix = prefix ? stripSlashes(prefix).normalize('NFC') : '';

  if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) {
    relative = relative.slice(normalizedPrefix.length + 1);
  } else if (normalizedPrefix && relative === normalizedPrefix) {
    // Handle edge case where googleCloudStoragePath exactly equals the prefix (no trailing slash)
    relative = '';
  }

  // Strip trailing slashes (Google Cloud Storage directory markers)
  relative = relative.replace(/\/+$/, '');

  return relative;
}

/**
 * Build a directory prefix for Google Cloud Storage getFiles().
 * Ensures the prefix ends with '/' for directory listing.
 *
 * @param userPath - User-provided directory path (optional).
 * @param prefix - Bucket-level prefix (optional).
 * @returns Google Cloud Storage prefix string ending with '/' for directory scoping.
 */
export function toGoogleCloudStoragePrefix(userPath: string | undefined, prefix?: string): string {
  const path = toGoogleCloudStoragePath(userPath, prefix);
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
