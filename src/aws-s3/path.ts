import { normalizePath, encodeCJK } from '../core/index.js';

/**
 * Convert a user-facing path to an S3 object key.
 *
 * Processing:
 * 1. If path is empty/undefined, return prefix as-is (root listing).
 * 2. Run `normalizePath` for security checks (traversal, absolute path, etc.).
 * 3. Encode CJK/non-ASCII characters via `encodeCJK`.
 * 4. Prepend prefix if configured.
 *
 * @param userPath - User-provided relative path.
 * @param prefix - Optional bucket prefix (e.g., "data/uploads").
 * @returns S3 object key suitable for SDK commands.
 *
 * @example
 * ```typescript
 * toS3Key('reports/月次.csv', 'data');
 * // 'data/reports/%E6%9C%88%E6%AC%A1.csv'
 * ```
 */
export function toS3Key(userPath: string | undefined, prefix?: string): string {
  const normalizedPrefix = prefix ? stripSlashes(prefix) : '';

  if (userPath === undefined || userPath === null || userPath.trim() === '') {
    return normalizedPrefix ? `${normalizedPrefix}/` : '';
  }

  const safe = normalizePath(userPath);
  const encoded = encodeCJK(safe);

  if (normalizedPrefix) {
    return `${normalizedPrefix}/${encoded}`;
  }
  return encoded;
}

/**
 * Convert an S3 object key back to a user-facing path.
 *
 * Processing:
 * 1. Strip the prefix from the key.
 * 2. Decode percent-encoded CJK characters.
 * 3. Strip trailing slashes (directory markers).
 *
 * @param s3Key - S3 object key from SDK response.
 * @param prefix - Optional bucket prefix to strip.
 * @returns User-facing path with decoded Unicode characters.
 *
 * @example
 * ```typescript
 * fromS3Key('data/reports/%E6%9C%88%E6%AC%A1.csv', 'data');
 * // 'reports/月次.csv'
 * ```
 */
export function fromS3Key(s3Key: string, prefix?: string): string {
  const normalizedPrefix = prefix ? stripSlashes(prefix) : '';

  let relative = s3Key;
  if (normalizedPrefix && relative.startsWith(`${normalizedPrefix}/`)) {
    relative = relative.slice(normalizedPrefix.length + 1);
  }

  // Decode percent-encoded characters (CJK and others)
  try {
    relative = decodeURIComponent(relative);
  } catch {
    // If decoding fails, keep the original string
  }

  // Strip trailing slashes (S3 directory markers)
  relative = relative.replace(/\/+$/, '');

  return relative;
}

/**
 * Build a directory prefix for S3 ListObjectsV2.
 * Ensures the prefix ends with '/' for directory listing.
 *
 * @param userPath - User-provided directory path (optional).
 * @param prefix - Bucket-level prefix (optional).
 * @returns S3 prefix string ending with '/' for directory scoping.
 */
export function toS3Prefix(userPath: string | undefined, prefix?: string): string {
  const key = toS3Key(userPath, prefix);
  if (key === '') {
    return '';
  }
  // Ensure trailing slash for directory listing
  return key.endsWith('/') ? key : `${key}/`;
}

/**
 * Strip leading and trailing slashes from a string.
 */
function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}
