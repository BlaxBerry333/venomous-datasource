import { describe, it, expect } from 'vitest';
import {
  VenomousError,
  AuthenticationError,
  ConnectionError,
  QueryError,
  PathError,
  NotFoundError,
  PermissionError,
} from './index.js';

describe('VenomousError', () => {
  it('should create an error with default code', () => {
    const error = new VenomousError('something went wrong');
    expect(error.message).toBe('something went wrong');
    expect(error.code).toBe('VENOMOUS_ERROR');
    expect(error.name).toBe('VenomousError');
    expect(error.connector).toBeUndefined();
  });

  it('should create an error with custom code and connector', () => {
    const error = new VenomousError('test', {
      code: 'CUSTOM_CODE',
      connector: 'bigquery',
    });
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.connector).toBe('bigquery');
  });

  it('should preserve cause chain', () => {
    const cause = new Error('original error');
    const error = new VenomousError('wrapped', { cause });
    expect(error.cause).toBe(cause);
  });

  it('should be instanceof Error', () => {
    const error = new VenomousError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(VenomousError);
  });

  it('toJSON should return sanitized output', () => {
    const cause = new Error('secret key is invalid');
    const error = new VenomousError('auth failed', {
      code: 'VENOMOUS_AUTH_FAILED',
      connector: 'aws-s3',
      cause,
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: 'VenomousError',
      code: 'VENOMOUS_AUTH_FAILED',
      message: 'auth failed',
      connector: 'aws-s3',
      cause: { name: 'Error', message: 'secret key is invalid' },
    });
  });

  it('toJSON should handle no cause', () => {
    const error = new VenomousError('test');
    const json = error.toJSON();
    expect(json.cause).toBeUndefined();
  });

  it('toJSON should handle non-Error cause', () => {
    const error = new VenomousError('test', { cause: 'string cause' });
    const json = error.toJSON();
    expect(json.cause).toBeUndefined();
  });
});

describe('AuthenticationError', () => {
  it('should have correct defaults', () => {
    const error = new AuthenticationError('bad credentials');
    expect(error.name).toBe('AuthenticationError');
    expect(error.code).toBe('VENOMOUS_AUTH_FAILED');
    expect(error).toBeInstanceOf(VenomousError);
    expect(error).toBeInstanceOf(Error);
  });

  it('should accept custom code', () => {
    const error = new AuthenticationError('expired', {
      code: 'VENOMOUS_AUTH_EXPIRED',
      connector: 'google-cloud-storage',
    });
    expect(error.code).toBe('VENOMOUS_AUTH_EXPIRED');
    expect(error.connector).toBe('google-cloud-storage');
  });
});

describe('ConnectionError', () => {
  it('should have correct defaults', () => {
    const error = new ConnectionError('network timeout');
    expect(error.name).toBe('ConnectionError');
    expect(error.code).toBe('VENOMOUS_CONNECTION_FAILED');
    expect(error).toBeInstanceOf(VenomousError);
  });
});

describe('QueryError', () => {
  it('should have correct defaults', () => {
    const error = new QueryError('syntax error');
    expect(error.name).toBe('QueryError');
    expect(error.code).toBe('VENOMOUS_QUERY_FAILED');
    expect(error).toBeInstanceOf(VenomousError);
  });
});

describe('PathError', () => {
  it('should have correct defaults', () => {
    const error = new PathError('traversal detected');
    expect(error.name).toBe('PathError');
    expect(error.code).toBe('VENOMOUS_PATH_INVALID');
    expect(error).toBeInstanceOf(VenomousError);
  });

  it('should accept custom path-specific code', () => {
    const error = new PathError('traversal', { code: 'VENOMOUS_PATH_TRAVERSAL' });
    expect(error.code).toBe('VENOMOUS_PATH_TRAVERSAL');
  });
});

describe('NotFoundError', () => {
  it('should have correct defaults', () => {
    const error = new NotFoundError('table not found');
    expect(error.name).toBe('NotFoundError');
    expect(error.code).toBe('VENOMOUS_NOT_FOUND');
    expect(error).toBeInstanceOf(VenomousError);
  });
});

describe('PermissionError', () => {
  it('should have correct defaults', () => {
    const error = new PermissionError('access denied');
    expect(error.name).toBe('PermissionError');
    expect(error.code).toBe('VENOMOUS_PERMISSION_DENIED');
    expect(error).toBeInstanceOf(VenomousError);
  });
});

describe('Error inheritance chain', () => {
  const errorClasses = [
    { Cls: AuthenticationError, name: 'AuthenticationError' },
    { Cls: ConnectionError, name: 'ConnectionError' },
    { Cls: QueryError, name: 'QueryError' },
    { Cls: PathError, name: 'PathError' },
    { Cls: NotFoundError, name: 'NotFoundError' },
    { Cls: PermissionError, name: 'PermissionError' },
  ] as const;

  for (const { Cls, name } of errorClasses) {
    it(`${name} instanceof VenomousError should be true`, () => {
      const error = new Cls('test');
      expect(error).toBeInstanceOf(VenomousError);
      expect(error).toBeInstanceOf(Error);
    });

    it(`${name} should have correct name`, () => {
      const error = new Cls('test');
      expect(error.name).toBe(name);
    });

    it(`${name} should support cause chain and toJSON`, () => {
      const cause = new Error('root cause');
      const error = new Cls('wrapped', { cause, connector: 'test' });
      expect(error.cause).toBe(cause);
      const json = error.toJSON();
      expect(json.cause).toEqual({ name: 'Error', message: 'root cause' });
    });
  }
});
