import { VenomousError } from './base.js';

/**
 * Thrown when a query fails (syntax error, execution failure, invalid cursor, etc.).
 */
export class QueryError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_QUERY_FAILED',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'QueryError';
  }
}
