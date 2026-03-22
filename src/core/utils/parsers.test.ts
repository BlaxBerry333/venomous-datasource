import { describe, it, expect } from 'vitest';
import { parseCsv, parseJson, getFileFormat } from './parsers.js';
import { QueryError } from '../errors/query.js';

describe('parseCsv', () => {
  it('parses basic CSV with header and data', () => {
    const result = parseCsv('name,age\nAlice,30\nBob,25', 10);
    expect(result.columns).toEqual([
      { name: 'name', type: 'string', nullable: true },
      { name: 'age', type: 'string', nullable: true },
    ]);
    expect(result.data).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  it('strips BOM from content', () => {
    const bom = '\uFEFF';
    const result = parseCsv(`${bom}name,value\ntest,1`, 10);
    expect(result.columns[0]!.name).toBe('name');
    expect(result.data).toEqual([{ name: 'test', value: '1' }]);
  });

  it('returns empty for empty content', () => {
    const result = parseCsv('', 10);
    expect(result.columns).toEqual([]);
    expect(result.data).toEqual([]);
  });

  it('handles quoted fields with embedded commas', () => {
    const result = parseCsv('name,address\nAlice,"123 Main St, Apt 4"', 10);
    expect(result.data[0]).toEqual({
      name: 'Alice',
      address: '123 Main St, Apt 4',
    });
  });

  it('handles escaped quotes inside quoted fields', () => {
    const result = parseCsv('name,quote\nAlice,"She said ""hello"""', 10);
    expect(result.data[0]).toEqual({
      name: 'Alice',
      quote: 'She said "hello"',
    });
  });

  it('handles newlines inside quoted fields', () => {
    const result = parseCsv('name,bio\nAlice,"Line 1\nLine 2"', 10);
    expect(result.data[0]).toEqual({
      name: 'Alice',
      bio: 'Line 1\nLine 2',
    });
  });

  it('respects maxRows limit', () => {
    const csv = 'id\n1\n2\n3\n4\n5';
    const result = parseCsv(csv, 3);
    expect(result.data).toHaveLength(3);
    expect(result.data[2]).toEqual({ id: '3' });
  });

  it('handles rows with fewer fields than header', () => {
    const result = parseCsv('a,b,c\n1', 10);
    expect(result.data[0]).toEqual({ a: '1', b: null, c: null });
  });

  it('handles CRLF line endings', () => {
    const result = parseCsv('name,age\r\nAlice,30\r\nBob,25', 10);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ name: 'Alice', age: '30' });
  });

  it('trims header names', () => {
    const result = parseCsv(' name , age \nAlice,30', 10);
    expect(result.columns[0]!.name).toBe('name');
    expect(result.columns[1]!.name).toBe('age');
  });

  it('handles header-only CSV (no data rows)', () => {
    const result = parseCsv('name,age', 10);
    expect(result.columns).toHaveLength(2);
    expect(result.data).toEqual([]);
  });

  it('handles CSV with trailing comma (empty trailing field)', () => {
    const result = parseCsv('a,b,c\n1,2,', 10);
    expect(result.data[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('handles CSV with CJK characters in header and data', () => {
    const result = parseCsv('\u540D\u524D,\u5E74\u9F62\n\u592A\u90CE,25', 10);
    expect(result.columns[0]!.name).toBe('\u540D\u524D');
    expect(result.data[0]).toEqual({ '\u540D\u524D': '\u592A\u90CE', '\u5E74\u9F62': '25' });
  });

  it('handles maxRows of 0 (returns no data rows)', () => {
    const result = parseCsv('id\n1\n2\n3', 0);
    // maxRows=0 means header is parsed but no data rows
    expect(result.columns).toHaveLength(1);
    expect(result.data).toEqual([]);
  });
});

describe('parseJson', () => {
  it('parses JSON array', () => {
    const result = parseJson('[{"id":1},{"id":2}]', 10);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('respects maxRows for JSON array', () => {
    const arr = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const result = parseJson(arr, 2);
    expect(result.data).toHaveLength(2);
  });

  it('parses primitive array', () => {
    const result = parseJson('[1, 2, 3]', 10);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('throws QueryError for invalid JSON starting with [', () => {
    expect(() => parseJson('[broken', 10)).toThrow(QueryError);
    expect(() => parseJson('[broken', 10)).toThrow('Failed to parse JSON array');
  });

  it('throws QueryError for invalid JSON array without leaking content', () => {
    try {
      parseJson('[{"secret":"password"}invalid', 10);
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      // The error message should not contain file content
      expect((err as QueryError).message).toBe('Failed to parse JSON array');
      expect((err as QueryError).cause).toBeUndefined();
    }
  });

  it('parses JSONL (newline-delimited JSON)', () => {
    const jsonl = '{"name":"Alice"}\n{"name":"Bob"}';
    const result = parseJson(jsonl, 10);
    expect(result.data).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
  });

  it('respects maxRows for JSONL', () => {
    const jsonl = '{"id":1}\n{"id":2}\n{"id":3}';
    const result = parseJson(jsonl, 2);
    expect(result.data).toHaveLength(2);
  });

  it('skips empty lines in JSONL', () => {
    const jsonl = '{"id":1}\n\n{"id":2}\n';
    const result = parseJson(jsonl, 10);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws QueryError with line number for invalid JSONL line', () => {
    const jsonl = '{"id":1}\nnot-json\n{"id":3}';
    expect(() => parseJson(jsonl, 10)).toThrow(QueryError);
    expect(() => parseJson(jsonl, 10)).toThrow('Failed to parse JSONL at line 2');
  });

  it('throws QueryError without connector field', () => {
    const jsonl = '{"id":1}\nbad';
    try {
      parseJson(jsonl, 10);
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).connector).toBeUndefined();
    }
  });

  it('trims whitespace from content', () => {
    const result = parseJson('  [{"id":1}]  ', 10);
    expect(result.data).toEqual([{ id: 1 }]);
  });

  it('parses empty JSON array', () => {
    const result = parseJson('[]', 10);
    expect(result.data).toEqual([]);
  });

  it('parses empty JSONL (whitespace only)', () => {
    const result = parseJson('  \n  \n  ', 10);
    expect(result.data).toEqual([]);
  });

  it('does not leak JSONL content in error messages', () => {
    const sensitiveContent = '{"password":"s3cr3t"}\n{invalid-with-secret-data}';
    try {
      parseJson(sensitiveContent, 10);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      const message = (err as QueryError).message;
      expect(message).not.toContain('s3cr3t');
      expect(message).not.toContain('invalid-with-secret-data');
      expect((err as QueryError).cause).toBeUndefined();
    }
  });

  it('handles JSONL with maxRows of 1', () => {
    const jsonl = '{"id":1}\n{"id":2}\n{"id":3}';
    const result = parseJson(jsonl, 1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({ id: 1 });
  });

  it('handles JSON array with nested objects', () => {
    const json = JSON.stringify([{ id: 1, meta: { name: 'test', tags: ['a', 'b'] } }]);
    const result = parseJson(json, 10);
    expect(result.data[0]).toEqual({ id: 1, meta: { name: 'test', tags: ['a', 'b'] } });
  });
});

describe('getFileFormat', () => {
  it('returns csv for .csv files', () => {
    expect(getFileFormat('data.csv')).toBe('csv');
    expect(getFileFormat('DATA.CSV')).toBe('csv');
    expect(getFileFormat('path/to/file.csv')).toBe('csv');
  });

  it('returns json for .json files', () => {
    expect(getFileFormat('data.json')).toBe('json');
    expect(getFileFormat('DATA.JSON')).toBe('json');
  });

  it('returns jsonl for .jsonl files', () => {
    expect(getFileFormat('data.jsonl')).toBe('jsonl');
    expect(getFileFormat('DATA.JSONL')).toBe('jsonl');
  });

  it('returns jsonl for .ndjson files', () => {
    expect(getFileFormat('data.ndjson')).toBe('jsonl');
    expect(getFileFormat('DATA.NDJSON')).toBe('jsonl');
  });

  it('returns null for unknown extensions', () => {
    expect(getFileFormat('data.txt')).toBeNull();
    expect(getFileFormat('data.xml')).toBeNull();
    expect(getFileFormat('data.parquet')).toBeNull();
    expect(getFileFormat('noextension')).toBeNull();
  });

  it('handles paths with multiple dots', () => {
    expect(getFileFormat('archive.2024.01.csv')).toBe('csv');
    expect(getFileFormat('data.backup.json')).toBe('json');
    expect(getFileFormat('log.2024.jsonl')).toBe('jsonl');
  });

  it('returns null for empty string', () => {
    expect(getFileFormat('')).toBeNull();
  });

  it('handles paths with directories', () => {
    expect(getFileFormat('/path/to/data.csv')).toBe('csv');
    expect(getFileFormat('bucket/prefix/file.ndjson')).toBe('jsonl');
  });
});
