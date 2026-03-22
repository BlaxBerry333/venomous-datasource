import { VenomousError } from './base.js';

/**
 * Thrown when a file path is invalid (traversal attack, absolute path, encoding error, etc.).
 */
export class PathError extends VenomousError {
  constructor(message: string, options?: { code?: string; cause?: unknown; connector?: string }) {
    super(message, {
      code: options?.code ?? 'VENOMOUS_PATH_INVALID',
      cause: options?.cause,
      connector: options?.connector,
    });
    this.name = 'PathError';
  }
}
