import { PathError } from '../errors/path.js';

const MAX_PATH_LENGTH = 1024;

/**
 * Normalize and validate a file path for safe use with cloud storage APIs.
 *
 * Processing order:
 * 1. Single-pass URL decode (handles `..%2F` etc.)
 * 2. Convert Windows backslashes to forward slashes
 * 3. NFC Unicode normalization
 * 4. Security checks (traversal, absolute path, empty, length)
 * 5. Strip leading/trailing slashes
 *
 * @param path - User-provided file path.
 * @returns Normalized safe path.
 * @throws {PathError} When the path is unsafe or invalid.
 *
 * @remarks Callers MUST NOT apply additional URL decoding to the returned path.
 * This function performs a single-pass URL decode internally. If the returned
 * value is decoded again, double-encoded traversal sequences (e.g., `%252e%252e%252f`)
 * could become dangerous `../` patterns.
 *
 * @example
 * ```typescript
 * normalizePath('data/file.csv');           // 'data/file.csv'
 * normalizePath('/data/file.csv');          // throws PathError (absolute)
 * normalizePath('../etc/passwd');           // throws PathError (traversal)
 * normalizePath('data/日本語.csv');          // 'data/日本語.csv' (NFC normalized)
 * ```
 */
export function normalizePath(path: string): string {
  if (path === undefined || path === null || path.trim() === '') {
    throw new PathError('Path must not be empty', { code: 'VENOMOUS_PATH_EMPTY' });
  }

  // Step 1: Single-pass URL decode to catch encoded traversal attempts
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // If decodeURIComponent fails (e.g., malformed `%` sequences), keep original
  }

  // Step 2: Convert Windows backslashes to forward slashes
  decoded = decoded.replace(/\\/g, '/');

  // Step 3: NFC Unicode normalization
  decoded = decoded.normalize('NFC');

  // Step 4a: Check for path traversal (must check after decode + backslash conversion)
  if (containsTraversal(decoded)) {
    throw new PathError('Path traversal detected', { code: 'VENOMOUS_PATH_TRAVERSAL' });
  }

  // Step 4b: Check for encoded traversal patterns that survive after single decode
  // Catches cases like `%2e%2e%2f` that were double-encoded and decoded once to `%2e%2e/`
  if (/%2e%2e/i.test(decoded)) {
    throw new PathError('Path traversal detected (encoded)', { code: 'VENOMOUS_PATH_TRAVERSAL' });
  }

  // Step 4c: Check for absolute path
  if (decoded.startsWith('/')) {
    throw new PathError('Absolute paths are not allowed', { code: 'VENOMOUS_PATH_ABSOLUTE' });
  }

  // Step 5: Strip trailing slashes (leading slashes are already rejected as absolute paths)
  const normalized = decoded.replace(/\/+$/g, '');

  // Handle path that is just "."
  if (normalized === '.') {
    return '';
  }

  // Step 4d: Check length after normalization
  if (normalized.length > MAX_PATH_LENGTH) {
    throw new PathError(`Path exceeds maximum length of ${MAX_PATH_LENGTH} characters`, {
      code: 'VENOMOUS_PATH_TOO_LONG',
    });
  }

  return normalized;
}

/**
 * Check whether a path is safe without throwing an exception.
 *
 * @param path - User-provided file path.
 * @returns `true` if the path is safe, `false` otherwise.
 */
export function isPathSafe(path: string): boolean {
  try {
    normalizePath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode non-ASCII characters in a path using `encodeURIComponent`.
 * Preserves `/` separators and printable ASCII characters (0x20-0x7E).
 * Primarily used by the S3 connector, which requires CJK characters to be percent-encoded.
 *
 * @remarks Spaces (0x20) are NOT encoded by this function. If the target storage
 * SDK requires spaces to be encoded as `%20`, the caller should handle that separately.
 *
 * @param path - A normalized path (output of `normalizePath`).
 * @returns Path with non-ASCII characters percent-encoded.
 *
 * @example
 * ```typescript
 * encodeCJK('data/日本語ファイル.csv');
 * // 'data/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.csv'
 * ```
 */
export function encodeCJK(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.replace(/[^\x20-\x7E]/g, (char) => encodeURIComponent(char)))
    .join('/');
}

/**
 * Detect path traversal patterns in a decoded path string.
 * Checks each path segment for exact `..` match.
 */
function containsTraversal(path: string): boolean {
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      return true;
    }
  }
  return false;
}
