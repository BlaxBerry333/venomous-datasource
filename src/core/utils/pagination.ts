import { QueryError } from '../errors/query.js';

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 50;
const CURSOR_VERSION = 1;
const CURSOR_LENGTH_WARNING_THRESHOLD = 2048;

/**
 * Validate and clamp a page size to the allowed range [1, 1000].
 *
 * @param size - Requested page size.
 * @returns Object with the clamped value and whether it was modified.
 *
 * @example
 * ```typescript
 * validatePageSize(50);    // { value: 50, truncated: false }
 * validatePageSize(2000);  // { value: 1000, truncated: true }
 * validatePageSize(NaN);   // { value: 50, truncated: true }
 * validatePageSize(-5);    // { value: 1, truncated: true }
 * ```
 */
export function validatePageSize(size: number): { value: number; truncated: boolean } {
  // Handle NaN, Infinity, and non-finite values
  if (!Number.isFinite(size)) {
    return { value: DEFAULT_PAGE_SIZE, truncated: true };
  }

  if (size < MIN_PAGE_SIZE) {
    return { value: MIN_PAGE_SIZE, truncated: true };
  }

  if (size > MAX_PAGE_SIZE) {
    return { value: MAX_PAGE_SIZE, truncated: true };
  }

  // Round to integer
  const rounded = Math.round(size);
  return { value: rounded, truncated: rounded !== size };
}

/**
 * Encode an internal pagination state object into an opaque cursor string.
 * The cursor includes a version number for future format upgrades.
 *
 * @param state - Internal pagination state to encode.
 * @returns Base64url-encoded cursor string.
 *
 * @example
 * ```typescript
 * const cursor = encodeCursor({ pageToken: 'abc123', offset: 50 });
 * // Returns an opaque base64url string
 * ```
 */
export function encodeCursor(state: Record<string, unknown>): string {
  const payload = { v: CURSOR_VERSION, ...state };
  const json = JSON.stringify(payload);
  const encoded = base64UrlEncode(json);

  if (encoded.length > CURSOR_LENGTH_WARNING_THRESHOLD) {
    console.warn(
      `[venomous] Cursor length (${encoded.length}) exceeds ${CURSOR_LENGTH_WARNING_THRESHOLD} characters. ` +
        'This may cause issues with URL length limits.'
    );
  }

  return encoded;
}

/**
 * Decode an opaque cursor string back into an internal pagination state object.
 *
 * @param cursor - Previously encoded cursor string.
 * @returns Decoded pagination state (without the version field).
 * @throws {QueryError} When the cursor is invalid (bad base64, invalid JSON, wrong version).
 *
 * @example
 * ```typescript
 * const state = decodeCursor(cursor);
 * // { pageToken: 'abc123', offset: 50 }
 * ```
 */
export function decodeCursor(cursor: string): Record<string, unknown> {
  let json: string;
  try {
    json = base64UrlDecode(cursor);
  } catch {
    throw new QueryError('Invalid cursor: failed to decode base64', {
      code: 'VENOMOUS_INVALID_CURSOR',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new QueryError('Invalid cursor: failed to parse JSON', {
      code: 'VENOMOUS_INVALID_CURSOR',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new QueryError('Invalid cursor: expected an object', {
      code: 'VENOMOUS_INVALID_CURSOR',
    });
  }

  const record = parsed as Record<string, unknown>;

  // Version check
  if (record['v'] !== CURSOR_VERSION) {
    throw new QueryError(
      `Invalid cursor: unsupported version (expected ${CURSOR_VERSION}, got ${String(record['v'])})`,
      { code: 'VENOMOUS_INVALID_CURSOR' }
    );
  }

  // Remove version field from returned state
  const { v: _version, ...state } = record;
  return state;
}

/**
 * Base64url encode a string (URL-safe, no padding).
 */
function base64UrlEncode(input: string): string {
  const base64 = Buffer.from(input, 'utf-8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url decode a string.
 * Validates that the input contains only valid base64url characters before decoding.
 */
function base64UrlDecode(input: string): string {
  // Validate base64url characters (A-Z, a-z, 0-9, -, _)
  if (!/^[A-Za-z0-9\-_]*$/.test(input)) {
    throw new Error('Invalid base64url characters');
  }

  // Restore standard base64 characters
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  const padLength = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLength);
  return Buffer.from(base64, 'base64').toString('utf-8');
}
