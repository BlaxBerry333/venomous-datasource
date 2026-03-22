import { VenomousError } from './base.js';

/**
 * Thrown when authentication fails (invalid credentials, expired tokens, etc.).
 */
export class AuthenticationError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_AUTH_FAILED',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'AuthenticationError';
  }
}
