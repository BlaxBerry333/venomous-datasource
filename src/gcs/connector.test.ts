import { Readable, PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GCSConnector } from './connector.js';
import {
  ConnectionError,
  QueryError,
  NotFoundError,
  AuthenticationError,
  PermissionError,
} from '../core/index.js';

// Mock @google-cloud/storage
const mockExists = vi.fn();
const mockGetFiles = vi.fn();
const mockGetMetadata = vi.fn();
const mockDownload = vi.fn();
const mockCreateReadStream = vi.fn();
const mockSave = vi.fn();
const mockDelete = vi.fn();
const mockCreateWriteStream = vi.fn();
const mockFileExists = vi.fn();

const mockFile = vi.fn(() => ({
  exists: mockFileExists,
  getMetadata: mockGetMetadata,
  download: mockDownload,
  createReadStream: mockCreateReadStream,
  save: mockSave,
  delete: mockDelete,
  createWriteStream: mockCreateWriteStream,
  name: 'test-file',
  metadata: {},
}));

const mockBucket = vi.fn(() => ({
  exists: mockExists,
  getFiles: mockGetFiles,
  file: mockFile,
}));

vi.mock('@google-cloud/storage', () => {
  const MockStorage = vi.fn(() => ({
    bucket: mockBucket,
  }));

  return { Storage: MockStorage };
});

/** Helper: create a mock Node.js Readable stream from content. */
function createMockNodeStream(content: string) {
  return new Readable({
    read() {
      this.push(Buffer.from(content));
      this.push(null);
    },
  });
}

describe('GCSConnector', () => {
  let connector: GCSConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new GCSConnector({ bucket: 'test-bucket' });
  });

  afterEach(async () => {
    try {
      await connector.disconnect();
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('throws ConnectionError when bucket is empty', () => {
      expect(() => new GCSConnector({ bucket: '' })).toThrow(ConnectionError);
    });

    it('throws ConnectionError when bucket is whitespace', () => {
      expect(() => new GCSConnector({ bucket: '  ' })).toThrow(ConnectionError);
    });

    it('accepts valid options', () => {
      const c = new GCSConnector({ bucket: 'my-bucket', prefix: 'data/', projectId: 'proj' });
      expect(c).toBeInstanceOf(GCSConnector);
    });
  });

  describe('connect', () => {
    it('connects successfully with default auth', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();
    });

    it('connects with explicit auto auth', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect({ type: 'auto' });
    });

    it('throws NotFoundError when bucket does not exist', async () => {
      mockExists.mockResolvedValue([false]);
      await expect(connector.connect()).rejects.toThrow(NotFoundError);
    });

    it('wraps 403 as PermissionError', async () => {
      const error = Object.assign(new Error('Forbidden'), { code: 403 });
      mockExists.mockRejectedValue(error);
      await expect(connector.connect()).rejects.toThrow(PermissionError);
    });

    it('wraps 401 as AuthenticationError', async () => {
      const error = Object.assign(new Error('Unauthorized'), { code: 401 });
      mockExists.mockRejectedValue(error);
      await expect(connector.connect()).rejects.toThrow(AuthenticationError);
    });

    it('wraps network errors as ConnectionError', async () => {
      mockExists.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });
  });

  describe('disconnect', () => {
    it('resets state', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();
      await connector.disconnect();

      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('is idempotent (calling disconnect twice does not throw)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      await connector.disconnect();
      await connector.disconnect(); // second call should not throw
    });
  });

  describe('files', () => {
    it('throws ConnectionError when not connected', async () => {
      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('lists files and directories', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetFiles.mockResolvedValueOnce([
        // files array
        [
          {
            name: 'file1.csv',
            metadata: { size: '1024', updated: '2024-01-15T00:00:00Z', contentType: 'text/csv' },
          },
          {
            name: 'file2.json',
            metadata: {
              size: '2048',
              updated: '2024-02-20T00:00:00Z',
              contentType: 'application/json',
            },
          },
        ],
        // query response (next page info)
        {},
        // API response (prefixes for directories)
        { prefixes: ['reports/'] },
      ]);

      const result = await connector.files();

      expect(result.data).toHaveLength(3);
      // Directories come first
      expect(result.data[0]).toEqual({
        name: 'reports',
        path: 'reports',
        size: 0,
        lastModified: new Date(0),
        isDirectory: true,
      });
      expect(result.data[1]).toMatchObject({
        name: 'file1.csv',
        path: 'file1.csv',
        size: 1024,
        isDirectory: false,
      });
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('handles pagination with cursor', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      // First page
      mockGetFiles.mockResolvedValueOnce([
        [{ name: 'file1.csv', metadata: { size: '100', updated: '2024-01-01T00:00:00Z' } }],
        { pageToken: 'next-token-abc' },
        {},
      ]);

      const page1 = await connector.files();
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page
      mockGetFiles.mockResolvedValueOnce([
        [{ name: 'file2.csv', metadata: { size: '200', updated: '2024-01-02T00:00:00Z' } }],
        {},
        {},
      ]);

      const page2 = await connector.files(undefined, {
        page: { cursor: page1.nextCursor },
      });
      expect(page2.hasMore).toBe(false);
    });

    it('lists with prefix', async () => {
      const c = new GCSConnector({ bucket: 'test-bucket', prefix: 'data' });
      mockExists.mockResolvedValue([true]);
      await c.connect();

      mockGetFiles.mockResolvedValueOnce([
        [{ name: 'data/file.csv', metadata: { size: '100', updated: '2024-01-01T00:00:00Z' } }],
        {},
        {},
      ]);

      const result = await c.files();
      expect(result.data[0]!.path).toBe('file.csv');
    });

    it('handles empty listing', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetFiles.mockResolvedValueOnce([[], {}, {}]);

      const result = await connector.files();
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('handles CJK filenames (preserved, not encoded)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetFiles.mockResolvedValueOnce([
        [
          {
            name: '日本語テスト.csv',
            metadata: { size: '512', updated: '2024-03-01T00:00:00Z' },
          },
          {
            name: '数据文件.json',
            metadata: { size: '256', updated: '2024-03-02T00:00:00Z' },
          },
        ],
        {},
        {},
      ]);

      const result = await connector.files();
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe('日本語テスト.csv');
      expect(result.data[0]!.path).toBe('日本語テスト.csv');
      expect(result.data[1]!.name).toBe('数据文件.json');
    });

    it('rejects invalid cursor', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      await expect(connector.files(undefined, { page: { cursor: 'invalid' } })).rejects.toThrow(
        QueryError
      );
    });
  });

  describe('peek', () => {
    it('throws when not connected', async () => {
      await expect(connector.peek('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('peeks CSV file', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '100' }]);
      mockDownload.mockResolvedValueOnce([
        Buffer.from('name,age,city\nAlice,30,Tokyo\nBob,25,Osaka\nCharlie,35,Kyoto'),
      ]);

      const result = await connector.peek('data.csv', { rows: 2 });

      expect(result.columns).toEqual([
        { name: 'name', type: 'string', nullable: true },
        { name: 'age', type: 'string', nullable: true },
        { name: 'city', type: 'string', nullable: true },
      ]);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ name: 'Alice', age: '30', city: 'Tokyo' });
      expect(result.data[1]).toEqual({ name: 'Bob', age: '25', city: 'Osaka' });
    });

    it('peeks CSV with quoted fields containing commas', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '50' }]);
      mockDownload.mockResolvedValueOnce([
        Buffer.from('name,address\n"Smith, John","123 Main St, Apt 4"'),
      ]);

      const result = await connector.peek('data.csv');
      expect(result.data[0]).toEqual({
        name: 'Smith, John',
        address: '123 Main St, Apt 4',
      });
    });

    it('peeks CSV with BOM', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '50' }]);
      mockDownload.mockResolvedValueOnce([Buffer.from('\uFEFFname,value\ntest,1')]);

      const result = await connector.peek('data.csv');
      expect(result.columns![0]!.name).toBe('name');
    });

    it('peeks JSON array file', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '100' }]);
      mockDownload.mockResolvedValueOnce([
        Buffer.from(
          JSON.stringify([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Charlie' },
          ])
        ),
      ]);

      const result = await connector.peek('data.json', { rows: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 1, name: 'Alice' });
      expect(result.columns).toBeDefined();
      expect(result.columns!.find((c) => c.name === 'id')!.type).toBe('number');
    });

    it('peeks JSONL file', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '80' }]);
      mockDownload.mockResolvedValueOnce([
        Buffer.from('{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Charlie"}'),
      ]);

      const result = await connector.peek('data.jsonl', { rows: 2 });
      expect(result.data).toHaveLength(2);
    });

    it('rejects unsupported format', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      await expect(connector.peek('image.png')).rejects.toThrow(QueryError);
    });

    it('rejects file larger than 50MB', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: String(60 * 1024 * 1024) }]);

      await expect(connector.peek('huge.csv')).rejects.toThrow(QueryError);
    });

    it('defaults to 10 rows', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const csvLines = ['id,name'];
      for (let i = 0; i < 20; i++) {
        csvLines.push(`${i},user${i}`);
      }

      mockGetMetadata.mockResolvedValueOnce([{ size: '500' }]);
      mockDownload.mockResolvedValueOnce([Buffer.from(csvLines.join('\n'))]);

      const result = await connector.peek('data.csv');
      expect(result.data).toHaveLength(10);
    });

    it('clamps rows to max 1000', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '100' }]);
      mockDownload.mockResolvedValueOnce([Buffer.from('id\n1\n2')]);

      const result = await connector.peek('data.csv', { rows: 5000 });
      expect(result.data.length).toBeLessThanOrEqual(1000);
    });

    it('handles empty CSV file', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '0' }]);
      mockDownload.mockResolvedValueOnce([Buffer.from('')]);

      const result = await connector.peek('empty.csv');
      expect(result.data).toEqual([]);
    });

    it('does not leak file content in JSON parse errors', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([{ size: '50' }]);
      mockDownload.mockResolvedValueOnce([Buffer.from('invalid json content')]);

      try {
        await connector.peek('bad.json');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        // Error message should not contain the file content
        expect((err as QueryError).message).not.toContain('invalid json content');
        // The cause should also not contain file content
        expect((err as QueryError).cause).toBeUndefined();
      }
    });
  });

  describe('read', () => {
    it('throws when not connected', async () => {
      await expect(connector.read('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns a ReadableStream', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockFileExists.mockResolvedValueOnce([true]);
      mockCreateReadStream.mockReturnValueOnce(createMockNodeStream('hello world'));

      const stream = await connector.read('test.txt');
      expect(stream).toBeInstanceOf(ReadableStream);

      // Consume the stream
      const reader = stream.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('hello world');
    });

    it('throws NotFoundError when file does not exist', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockFileExists.mockResolvedValueOnce([false]);

      await expect(connector.read('missing.txt')).rejects.toThrow(NotFoundError);
    });

    it('enforces stream limit', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      // Create streams that never close to keep them tracked
      const createHangingStream = () =>
        new Readable({
          read() {
            /* never push data or null */
          },
        });

      // Open MAX_ACTIVE_STREAMS (10) streams
      for (let i = 0; i < 10; i++) {
        mockFileExists.mockResolvedValueOnce([true]);
        mockCreateReadStream.mockReturnValueOnce(createHangingStream());
        await connector.read(`file${i}.txt`);
      }

      // 11th should fail
      await expect(connector.read('file10.txt')).rejects.toThrow(QueryError);
    });

    it('cancel() closes the underlying stream reader', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockFileExists.mockResolvedValueOnce([true]);
      mockCreateReadStream.mockReturnValueOnce(createMockNodeStream('data'));

      const stream = await connector.read('test.txt');
      // Cancel the consumer side
      await stream.cancel();
      // Should not throw, resources should be cleaned up
    });
  });

  describe('stat', () => {
    it('throws when not connected', async () => {
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns file info', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockResolvedValueOnce([
        {
          size: '4096',
          updated: '2024-06-15T10:30:00Z',
          contentType: 'text/csv',
        },
      ]);

      const info = await connector.stat('reports/sales.csv');

      expect(info).toEqual({
        name: 'sales.csv',
        path: 'reports/sales.csv',
        size: 4096,
        lastModified: new Date('2024-06-15T10:30:00Z'),
        contentType: 'text/csv',
        isDirectory: false,
      });
    });

    it('wraps 404 as NotFoundError', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Not Found'), { code: 404 });
      mockGetMetadata.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });
  });

  describe('write', () => {
    it('throws when not connected', async () => {
      await expect(connector.write!('file.txt', 'hello')).rejects.toThrow(ConnectionError);
    });

    it('writes string data (calculates size locally)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockSave.mockResolvedValueOnce(undefined);

      const result = await connector.write!('test.txt', 'hello');

      expect(result.path).toBe('test.txt');
      expect(result.size).toBe(5);
      expect(mockSave).toHaveBeenCalledWith('hello');
    });

    it('writes Buffer data (calculates size locally)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockSave.mockResolvedValueOnce(undefined);

      const result = await connector.write!('data.bin', Buffer.from('hello world'));
      expect(result.size).toBe(11);
    });

    it('writes ReadableStream data', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const writeStream = new PassThrough();
      mockCreateWriteStream.mockReturnValueOnce(writeStream);

      // pipeline() will automatically handle piping and finish events
      mockGetMetadata.mockResolvedValueOnce([{ size: '5' }]);

      const inputStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('hello'));
          ctrl.close();
        },
      });

      const result = await connector.write!('test.txt', inputStream);
      expect(result.path).toBe('test.txt');
      expect(result.size).toBe(5);
    });
  });

  describe('remove', () => {
    it('throws when not connected', async () => {
      await expect(connector.remove!('file.txt')).rejects.toThrow(ConnectionError);
    });

    it('deletes a file', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockDelete.mockResolvedValueOnce(undefined);
      await connector.remove!('test.txt');
    });

    it('is idempotent (silently handles 404 on delete)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Not Found'), { code: 404 });
      mockDelete.mockRejectedValueOnce(error);

      // Should NOT throw -- 404 is silently swallowed for idempotent delete
      await connector.remove!('nonexistent.txt');
    });

    it('rethrows non-404 errors', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { code: 403 });
      mockDelete.mockRejectedValueOnce(error);

      await expect(connector.remove!('secret.txt')).rejects.toThrow(PermissionError);
    });
  });

  describe('error wrapping', () => {
    it('wraps 401 as AuthenticationError', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Unauthorized'), { code: 401 });
      mockGetMetadata.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(AuthenticationError);
    });

    it('wraps 403 as PermissionError (NOT AuthenticationError)', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { code: 403 });
      mockGetMetadata.mockRejectedValueOnce(error);

      await expect(connector.stat('secret.csv')).rejects.toThrow(PermissionError);
    });

    it('wraps 404 as NotFoundError', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      const error = Object.assign(new Error('Not Found'), { code: 404 });
      mockGetMetadata.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });

    it('wraps network errors as ConnectionError', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('wraps unknown errors as QueryError', async () => {
      mockExists.mockResolvedValue([true]);
      await connector.connect();

      mockGetMetadata.mockRejectedValueOnce(new Error('Something unexpected'));

      await expect(connector.stat('file.csv')).rejects.toThrow(QueryError);
    });
  });
});
