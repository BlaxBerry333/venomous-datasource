/**
 * Default set of sensitive field names that should be redacted from auth objects.
 */
const DEFAULT_SENSITIVE_FIELDS = new Set([
  'secretAccessKey',
  'accessKeyId',
  'credentials',
  'private_key',
  'client_email',
  'keyFilePath',
]);

const REDACTED = '[REDACTED]';

/**
 * Deep-clone an auth configuration object and replace sensitive field values
 * with `'[REDACTED]'`.
 *
 * @param auth - Any auth configuration object (or null/undefined/primitive).
 * @param additionalFields - Extra field names to redact beyond the defaults.
 * @returns A deep-cloned, redacted copy of the input.
 *
 * @example
 * ```typescript
 * const safe = redactAuth({
 *   type: 'access-key',
 *   accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
 *   secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
 *   region: 'us-east-1',
 * });
 * // { type: 'access-key', accessKeyId: '[REDACTED]', secretAccessKey: '[REDACTED]', region: 'us-east-1' }
 * ```
 */
export function redactAuth(auth: unknown, additionalFields?: string[]): unknown {
  if (auth === null || auth === undefined) {
    return auth;
  }

  if (typeof auth !== 'object') {
    return auth;
  }

  const sensitiveFields = additionalFields
    ? new Set([...DEFAULT_SENSITIVE_FIELDS, ...additionalFields])
    : DEFAULT_SENSITIVE_FIELDS;

  return redactObject(auth as Record<string, unknown>, sensitiveFields, new WeakSet());
}

/**
 * Recursively redact sensitive fields from an object.
 * Uses a WeakSet to detect and handle circular references.
 */
function redactObject(
  obj: Record<string, unknown>,
  sensitiveFields: Set<string>,
  visited: WeakSet<object>
): Record<string, unknown> {
  if (visited.has(obj)) {
    return { '[Circular]': true };
  }
  visited.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === 'object' && item !== null
        ? redactObject(item as Record<string, unknown>, sensitiveFields, visited)
        : item
    ) as unknown as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveFields.has(key)) {
      result[key] = REDACTED;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactObject(value as Record<string, unknown>, sensitiveFields, visited);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create a sanitized plain object from an Error, safe for logging/serialization.
 * Recursively processes the cause chain.
 *
 * @param error - Any error object.
 * @returns A plain object with sanitized error information.
 *
 * @example
 * ```typescript
 * try {
 *   await connector.connect(auth);
 * } catch (err) {
 *   const safe = sanitizeError(err);
 *   logger.error('Connection failed', safe);
 * }
 * ```
 */
const MAX_CAUSE_DEPTH = 10;

export function sanitizeError(error: unknown): Record<string, unknown> {
  return sanitizeErrorInternal(error, MAX_CAUSE_DEPTH);
}

/**
 * Internal recursive implementation with depth limit to prevent
 * stack overflow from circular cause chains.
 */
function sanitizeErrorInternal(error: unknown, remainingDepth: number): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  // Include code and connector if present (VenomousError fields)
  if ('code' in error && typeof error.code === 'string') {
    result['code'] = error.code;
  }
  if ('connector' in error && typeof error.connector === 'string') {
    result['connector'] = error.connector;
  }

  // Recursively sanitize cause chain with depth limit
  if (error.cause instanceof Error) {
    if (remainingDepth > 0) {
      result['cause'] = sanitizeErrorInternal(error.cause, remainingDepth - 1);
    } else {
      result['cause'] = { message: '[Truncated: cause chain too deep]' };
    }
  }

  return result;
}
