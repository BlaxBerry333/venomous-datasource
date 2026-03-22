import { VenomousError } from './base.js';

/**
 * Thrown when the caller lacks sufficient permissions (IAM, ACL, etc.).
 */
export class PermissionError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_PERMISSION_DENIED',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'PermissionError';
  }
}
