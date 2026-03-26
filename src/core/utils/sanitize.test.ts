import { describe, it, expect } from 'vitest';
import { redactAuth, sanitizeError } from './sanitize.js';
import { VenomousError } from '../errors/base.js';

describe('redactAuth', () => {
  it('should redact secretAccessKey', () => {
    const auth = {
      type: 'access-key',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    };
    const result = redactAuth(auth) as Record<string, unknown>;
    expect(result['secretAccessKey']).toBe('[REDACTED]');
    expect(result['accessKeyId']).toBe('[REDACTED]');
    expect(result['region']).toBe('us-east-1');
    expect(result['type']).toBe('access-key');
  });

  it('should redact credentials field', () => {
    const auth = {
      type: 'credentials',
      credentials: { private_key: 'SECRET', client_email: 'test@example.com' },
    };
    const result = redactAuth(auth) as Record<string, unknown>;
    expect(result['credentials']).toBe('[REDACTED]');
  });

  it('should redact private_key in nested objects', () => {
    const auth = {
      type: 'credentials',
      nested: { private_key: 'SECRET_KEY' },
    };
    const result = redactAuth(auth) as Record<string, unknown>;
    const nested = result['nested'] as Record<string, unknown>;
    expect(nested['private_key']).toBe('[REDACTED]');
  });

  it('should return null for null input', () => {
    expect(redactAuth(null)).toBeNull();
  });

  it('should return undefined for undefined input', () => {
    expect(redactAuth(undefined)).toBeUndefined();
  });

  it('should return primitive values unchanged', () => {
    expect(redactAuth('string')).toBe('string');
    expect(redactAuth(42)).toBe(42);
    expect(redactAuth(true)).toBe(true);
  });

  it('should not mutate the original object', () => {
    const auth = {
      type: 'access-key',
      secretAccessKey: 'SECRET',
    };
    redactAuth(auth);
    expect(auth.secretAccessKey).toBe('SECRET');
  });

  it('should handle additional fields parameter', () => {
    const auth = {
      type: 'custom',
      apiToken: 'my-secret-token',
      name: 'test',
    };
    const result = redactAuth(auth, ['apiToken']) as Record<string, unknown>;
    expect(result['apiToken']).toBe('[REDACTED]');
    expect(result['name']).toBe('test');
  });

  it('should handle arrays in objects', () => {
    const auth = {
      type: 'multi',
      items: [{ secretAccessKey: 'SECRET1' }, { secretAccessKey: 'SECRET2' }],
    };
    const result = redactAuth(auth) as Record<string, unknown>;
    const items = result['items'] as Record<string, unknown>[];
    expect(items[0]!['secretAccessKey']).toBe('[REDACTED]');
    expect(items[1]!['secretAccessKey']).toBe('[REDACTED]');
  });

  it('should handle empty object', () => {
    expect(redactAuth({})).toEqual({});
  });

  it('should redact client_email', () => {
    const auth = { client_email: 'sa@project.iam.gserviceaccount.com' };
    const result = redactAuth(auth) as Record<string, unknown>;
    expect(result['client_email']).toBe('[REDACTED]');
  });

  it('should handle circular references without stack overflow', () => {
    const auth: Record<string, unknown> = { type: 'test', name: 'foo' };
    auth['self'] = auth;
    const result = redactAuth(auth) as Record<string, unknown>;
    expect(result['type']).toBe('test');
    expect(result['self']).toEqual({ '[Circular]': true });
  });
});

describe('sanitizeError', () => {
  it('should sanitize a VenomousError', () => {
    const error = new VenomousError('connection failed', {
      code: 'VENOMOUS_CONNECTION_FAILED',
      connector: 'bigquery',
    });
    const result = sanitizeError(error);
    expect(result).toEqual({
      name: 'VenomousError',
      message: 'connection failed',
      code: 'VENOMOUS_CONNECTION_FAILED',
      connector: 'bigquery',
    });
  });

  it('should sanitize a plain Error', () => {
    const error = new Error('something broke');
    const result = sanitizeError(error);
    expect(result).toEqual({
      name: 'Error',
      message: 'something broke',
    });
  });

  it('should handle cause chain', () => {
    const root = new Error('root cause');
    const error = new VenomousError('wrapped', {
      code: 'TEST',
      cause: root,
    });
    const result = sanitizeError(error);
    expect(result['cause']).toEqual({
      name: 'Error',
      message: 'root cause',
    });
  });

  it('should handle non-Error input', () => {
    expect(sanitizeError('string error')).toEqual({ message: 'string error' });
    expect(sanitizeError(42)).toEqual({ message: '42' });
    expect(sanitizeError(null)).toEqual({ message: 'null' });
  });

  it('should handle deeply nested cause chain', () => {
    const root = new Error('level 0');
    const mid = new VenomousError('level 1', { code: 'L1', cause: root });
    const top = new VenomousError('level 2', { code: 'L2', cause: mid });
    const result = sanitizeError(top);
    const cause = result['cause'] as Record<string, unknown>;
    expect(cause['code']).toBe('L1');
    expect(cause['cause']).toEqual({ name: 'Error', message: 'level 0' });
  });

  it('should handle circular cause chain without stack overflow', () => {
    const err = new Error('circular');
    (err as unknown as Record<string, unknown>).cause = err;
    // Should not throw - depth limit prevents infinite recursion
    const result = sanitizeError(err);
    expect(result['name']).toBe('Error');
    expect(result['message']).toBe('circular');
    // Traverse down the cause chain to verify it eventually truncates
    let current = result;
    let depth = 0;
    while (current['cause'] && depth < 20) {
      current = current['cause'] as Record<string, unknown>;
      depth++;
    }
    // Should stop at max depth (10) + 1 for the truncation message
    expect(depth).toBeLessThanOrEqual(11);
  });
});
