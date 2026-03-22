import { VenomousError } from './base.js';

/**
 * Thrown when a connection to the data source fails (network errors, service unreachable, etc.).
 */
export class ConnectionError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_CONNECTION_FAILED',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'ConnectionError';
  }
}
