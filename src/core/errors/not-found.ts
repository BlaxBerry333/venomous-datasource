import { VenomousError } from './base.js';

/**
 * Thrown when a requested resource (table, file, bucket) does not exist.
 */
export class NotFoundError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_NOT_FOUND',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'NotFoundError';
  }
}
