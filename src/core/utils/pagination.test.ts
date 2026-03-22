import { describe, it, expect, vi } from 'vitest';
import { validatePageSize, encodeCursor, decodeCursor } from './pagination.js';
import { QueryError } from '../errors/query.js';

describe('validatePageSize', () => {
  it('should pass through a valid page size', () => {
    expect(validatePageSize(50)).toEqual({ value: 50, truncated: false });
  });

  it('should clamp size below minimum to 1', () => {
    expect(validatePageSize(0)).toEqual({ value: 1, truncated: true });
    expect(validatePageSize(-5)).toEqual({ value: 1, truncated: true });
    expect(validatePageSize(-100)).toEqual({ value: 1, truncated: true });
  });

  it('should clamp size above maximum to 1000', () => {
    expect(validatePageSize(1001)).toEqual({ value: 1000, truncated: true });
    expect(validatePageSize(999999)).toEqual({ value: 1000, truncated: true });
  });

  it('should return default 50 for NaN', () => {
    expect(validatePageSize(NaN)).toEqual({ value: 50, truncated: true });
  });

  it('should return default 50 for Infinity', () => {
    expect(validatePageSize(Infinity)).toEqual({ value: 50, truncated: true });
    expect(validatePageSize(-Infinity)).toEqual({ value: 50, truncated: true });
  });

  it('should accept boundary values', () => {
    expect(validatePageSize(1)).toEqual({ value: 1, truncated: false });
    expect(validatePageSize(1000)).toEqual({ value: 1000, truncated: false });
  });

  it('should round fractional values', () => {
    const result = validatePageSize(50.7);
    expect(result.value).toBe(51);
    expect(result.truncated).toBe(true);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('should round-trip a simple state object', () => {
    const state = { pageToken: 'abc123', offset: 50 };
    const cursor = encodeCursor(state);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(state);
  });

  it('should round-trip an empty object', () => {
    const state = {};
    const cursor = encodeCursor(state);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(state);
  });

  it('should round-trip complex state', () => {
    const state = {
      pageToken: 'eyJhbGciOiJIUzI1NiJ9',
      offset: 100,
      filter: { table: 'users' },
    };
    const cursor = encodeCursor(state);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(state);
  });

  it('should produce a base64url string (no +, /, =)', () => {
    const cursor = encodeCursor({ data: 'test/value+extra' });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('should not include version field in decoded output', () => {
    const cursor = encodeCursor({ key: 'value' });
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toHaveProperty('v');
  });

  it('should warn for very long cursors', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longValue = 'x'.repeat(3000);
    encodeCursor({ token: longValue });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
    warnSpy.mockRestore();
  });
});

/** Convert a string to base64url (matching the format encodeCursor produces). */
function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('decodeCursor error handling', () => {
  it('should throw QueryError for garbage input with invalid characters', () => {
    expect(() => decodeCursor('not-valid-base64!!!')).toThrow(QueryError);
  });

  it('should throw QueryError for non-JSON content', () => {
    const cursor = toBase64Url('not json');
    expect(() => decodeCursor(cursor)).toThrow(QueryError);
  });

  it('should throw QueryError for non-object JSON', () => {
    const cursor = toBase64Url('"just a string"');
    expect(() => decodeCursor(cursor)).toThrow(QueryError);
  });

  it('should throw QueryError for array JSON', () => {
    const cursor = toBase64Url('[1,2,3]');
    expect(() => decodeCursor(cursor)).toThrow(QueryError);
  });

  it('should throw QueryError for wrong version', () => {
    const cursor = toBase64Url(JSON.stringify({ v: 999, key: 'value' }));
    expect(() => decodeCursor(cursor)).toThrow(QueryError);
    expect(() => decodeCursor(cursor)).toThrow('unsupported version');
  });

  it('should throw QueryError for missing version', () => {
    const cursor = toBase64Url(JSON.stringify({ key: 'value' }));
    expect(() => decodeCursor(cursor)).toThrow(QueryError);
  });

  it('should use correct error code', () => {
    try {
      decodeCursor('invalid!!!');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      expect((e as QueryError).code).toBe('VENOMOUS_INVALID_CURSOR');
    }
  });
});
