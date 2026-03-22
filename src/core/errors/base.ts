/**
 * Base error class for all venomous-datasource errors.
 *
 * All errors include a machine-readable `code`, optional `connector` identifier,
 * and support for cause chaining. `toJSON()` automatically sanitizes sensitive
 * information from the output.
 *
 * @example
 * ```typescript
 * try {
 *   await connector.connect(auth);
 * } catch (err) {
 *   if (err instanceof VenomousError) {
 *     console.error(err.code, err.message);
 *     console.log(JSON.stringify(err)); // auto-sanitized
 *   }
 * }
 * ```
 */
export class VenomousError extends Error {
  /** Machine-readable error code (e.g., `VENOMOUS_AUTH_FAILED`). */
  readonly code: string;

  /** Connector type that produced this error (e.g., `bigquery`, `s3`). */
  readonly connector?: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      cause?: unknown;
      connector?: string;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'VenomousError';
    this.code = options?.code ?? 'VENOMOUS_ERROR';
    this.connector = options?.connector;

    // Fix prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a sanitized JSON representation.
   * Sensitive information (auth credentials, full file paths in cause) is excluded.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      connector: this.connector,
      cause:
        this.cause instanceof Error
          ? { name: this.cause.name, message: this.cause.message }
          : undefined,
    };
  }
}
