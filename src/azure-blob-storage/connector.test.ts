import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureBlobStorageConnector } from './connector.js';
import {
  ConnectionError,
  QueryError,
  NotFoundError,
  AuthenticationError,
  PermissionError,
  encodeCursor,
} from '../core/index.js';

// Mock Azure SDK
const mockContainerGetProperties = vi.fn();
const mockDownload = vi.fn();
const mockUpload = vi.fn();
const mockUploadStream = vi.fn();
const mockDeleteBlob = vi.fn();
const mockListBlobsByHierarchy = vi.fn();
const mockBlockBlobGetProperties = vi.fn();

const mockGetBlockBlobClient = vi.fn(() => ({
  getProperties: mockBlockBlobGetProperties,
  download: mockDownload,
  upload: mockUpload,
  uploadStream: mockUploadStream,
}));

const mockContainerClient = {
  getProperties: mockContainerGetProperties,
  getBlockBlobClient: mockGetBlockBlobClient,
  deleteBlob: mockDeleteBlob,
  listBlobsByHierarchy: mockListBlobsByHierarchy,
};

const mockGetContainerClient = vi.fn(() => mockContainerClient);

const mockBlobServiceClient = {
  getContainerClient: mockGetContainerClient,
};

// Mock resolveAuth
vi.mock('./auth.js', () => ({
  resolveAuth: vi.fn(async () => ({ client: mockBlobServiceClient })),
}));

/** Helper: create a mock Node.js Readable stream from content. */
function createMockNodeReadable(content: string) {
  return new Readable({
    read() {
      this.push(Buffer.from(content));
      this.push(null);
    },
  });
}

/** Helper: create a mock Azure download response. */
function createMockDownloadResponse(content: string) {
  return {
    readableStreamBody: createMockNodeReadable(content),
  };
}

describe('AzureBlobStorageConnector', () => {
  let connector: AzureBlobStorageConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new AzureBlobStorageConnector({ container: 'test-container' });
  });

  afterEach(async () => {
    try {
      await connector.disconnect();
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('throws ConnectionError when container is empty', () => {
      expect(() => new AzureBlobStorageConnector({ container: '' })).toThrow(ConnectionError);
    });

    it('throws ConnectionError when container is whitespace', () => {
      expect(() => new AzureBlobStorageConnector({ container: '  ' })).toThrow(ConnectionError);
    });

    it('accepts valid options', () => {
      const c = new AzureBlobStorageConnector({
        container: 'my-container',
        prefix: 'data/',
        accountName: 'myaccount',
      });
      expect(c).toBeInstanceOf(AzureBlobStorageConnector);
    });
  });

  describe('connect', () => {
    it('connects successfully with connection-string auth', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect({ type: 'connection-string', connectionString: 'test-conn-str' });
    });

    it('delegates auth validation to resolveAuth (undefined throws via mock)', async () => {
      const { resolveAuth } = await import('./auth.js');
      const mockResolveAuth = vi.mocked(resolveAuth);
      mockResolveAuth.mockRejectedValueOnce(
        new AuthenticationError('Authentication is required.', {
          code: 'VENOMOUS_AUTH_REQUIRED',
          connector: 'azure-blob-storage',
        })
      );
      await expect(connector.connect()).rejects.toThrow(AuthenticationError);
    });

    it('throws NotFoundError when container does not exist', async () => {
      const error = Object.assign(new Error('ContainerNotFound'), {
        statusCode: 404,
        code: 'ContainerNotFound',
      });
      mockContainerGetProperties.mockRejectedValue(error);
      await expect(connector.connect()).rejects.toThrow(NotFoundError);
    });

    it('wraps 403 as PermissionError', async () => {
      const error = Object.assign(new Error('Forbidden'), {
        statusCode: 403,
      });
      mockContainerGetProperties.mockRejectedValue(error);
      await expect(connector.connect()).rejects.toThrow(PermissionError);
    });

    it('wraps 401 as AuthenticationError', async () => {
      const error = Object.assign(new Error('Unauthorized'), {
        statusCode: 401,
      });
      mockContainerGetProperties.mockRejectedValue(error);
      await expect(connector.connect()).rejects.toThrow(AuthenticationError);
    });

    it('wraps network errors as ConnectionError', async () => {
      mockContainerGetProperties.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });
  });

  describe('disconnect', () => {
    it('resets state', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();
      await connector.disconnect();

      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('aborts active streams on disconnect', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const createHangingStream = () =>
        new Readable({
          read() {
            /* never push */
          },
        });

      // Open a stream
      const hangingStream = createHangingStream();
      mockDownload.mockResolvedValueOnce({ readableStreamBody: hangingStream });
      await connector.read('hanging.txt');

      // Disconnect should abort the stream
      await connector.disconnect();

      // Verify the node stream was destroyed
      expect(hangingStream.destroyed).toBe(true);
    });

    it('is idempotent (calling disconnect twice does not throw)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      await connector.disconnect();
      await connector.disconnect();
    });
  });

  describe('files', () => {
    it('throws ConnectionError when not connected', async () => {
      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('lists files and directories', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const mockPage = {
        value: {
          segment: {
            blobItems: [
              {
                name: 'file1.csv',
                properties: {
                  contentLength: 1024,
                  lastModified: new Date('2024-01-15T00:00:00Z'),
                  contentType: 'text/csv',
                },
              },
              {
                name: 'file2.json',
                properties: {
                  contentLength: 2048,
                  lastModified: new Date('2024-02-20T00:00:00Z'),
                  contentType: 'application/json',
                },
              },
            ],
            blobPrefixes: [{ name: 'reports/' }],
          },
          continuationToken: undefined,
        },
        done: false,
      };

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({ next: () => Promise.resolve(mockPage) }),
      });

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
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      // First page with continuation token
      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [
                    {
                      name: 'file1.csv',
                      properties: {
                        contentLength: 100,
                        lastModified: new Date('2024-01-01T00:00:00Z'),
                      },
                    },
                  ],
                  blobPrefixes: undefined,
                },
                continuationToken: 'next-token-abc',
              },
              done: false,
            }),
        }),
      });

      const page1 = await connector.files();
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page
      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [
                    {
                      name: 'file2.csv',
                      properties: {
                        contentLength: 200,
                        lastModified: new Date('2024-01-02T00:00:00Z'),
                      },
                    },
                  ],
                  blobPrefixes: undefined,
                },
                continuationToken: undefined,
              },
              done: false,
            }),
        }),
      });

      const page2 = await connector.files(undefined, {
        page: { cursor: page1.nextCursor },
      });
      expect(page2.hasMore).toBe(false);
    });

    it('lists with prefix', async () => {
      const c = new AzureBlobStorageConnector({ container: 'test-container', prefix: 'data' });
      mockContainerGetProperties.mockResolvedValue({});
      await c.connect();

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [
                    {
                      name: 'data/file.csv',
                      properties: {
                        contentLength: 100,
                        lastModified: new Date('2024-01-01T00:00:00Z'),
                      },
                    },
                  ],
                  blobPrefixes: undefined,
                },
                continuationToken: undefined,
              },
              done: false,
            }),
        }),
      });

      const result = await c.files();
      expect(result.data[0]!.path).toBe('file.csv');
    });

    it('handles empty listing', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [],
                  blobPrefixes: undefined,
                },
                continuationToken: undefined,
              },
              done: false,
            }),
        }),
      });

      const result = await connector.files();
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('handles blobPrefixes being undefined (null safety)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [
                    {
                      name: 'file.csv',
                      properties: { contentLength: 100, lastModified: new Date() },
                    },
                  ],
                  blobPrefixes: undefined,
                },
                continuationToken: undefined,
              },
              done: false,
            }),
        }),
      });

      // Should not throw
      const result = await connector.files();
      expect(result.data).toHaveLength(1);
    });

    it('handles CJK filenames (preserved, not encoded)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              value: {
                segment: {
                  blobItems: [
                    {
                      name: '日本語テスト.csv',
                      properties: {
                        contentLength: 512,
                        lastModified: new Date('2024-03-01T00:00:00Z'),
                      },
                    },
                    {
                      name: '数据文件.json',
                      properties: {
                        contentLength: 256,
                        lastModified: new Date('2024-03-02T00:00:00Z'),
                      },
                    },
                  ],
                  blobPrefixes: undefined,
                },
                continuationToken: undefined,
              },
              done: false,
            }),
        }),
      });

      const result = await connector.files();
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe('日本語テスト.csv');
      expect(result.data[0]!.path).toBe('日本語テスト.csv');
      expect(result.data[1]!.name).toBe('数据文件.json');
    });

    it('uses custom page size', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const byPageFn = vi.fn(() => ({
        next: () =>
          Promise.resolve({
            value: {
              segment: {
                blobItems: [],
                blobPrefixes: undefined,
              },
              continuationToken: undefined,
            },
            done: false,
          }),
      }));

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: byPageFn,
      });

      await connector.files(undefined, { page: { size: 25 } });
      expect(byPageFn).toHaveBeenCalledWith(expect.objectContaining({ maxPageSize: 25 }));
    });

    it('wraps listing errors via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockListBlobsByHierarchy.mockReturnValueOnce({
        byPage: () => ({
          next: () => Promise.reject(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
        }),
      });

      await expect(connector.files()).rejects.toThrow(PermissionError);
    });

    it('rejects invalid cursor (bad base64)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      await expect(connector.files(undefined, { page: { cursor: 'invalid' } })).rejects.toThrow(
        QueryError
      );
    });

    it('rejects cursor with missing token field', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      // Encode a cursor without a 'token' key
      const cursorWithoutToken = encodeCursor({ offset: 10 });

      await expect(
        connector.files(undefined, { page: { cursor: cursorWithoutToken } })
      ).rejects.toThrow(QueryError);
    });
  });

  describe('peek', () => {
    it('throws when not connected', async () => {
      await expect(connector.peek('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('peeks CSV file', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 100 });
      mockDownload.mockResolvedValueOnce(
        createMockDownloadResponse('name,age,city\nAlice,30,Tokyo\nBob,25,Osaka\nCharlie,35,Kyoto')
      );

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

    it('peeks JSON array file', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 100 });
      mockDownload.mockResolvedValueOnce(
        createMockDownloadResponse(
          JSON.stringify([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Charlie' },
          ])
        )
      );

      const result = await connector.peek('data.json', { rows: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 1, name: 'Alice' });
      expect(result.columns).toBeDefined();
      expect(result.columns!.find((c) => c.name === 'id')!.type).toBe('number');
    });

    it('peeks JSONL file', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 80 });
      mockDownload.mockResolvedValueOnce(
        createMockDownloadResponse(
          '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Charlie"}'
        )
      );

      const result = await connector.peek('data.jsonl', { rows: 2 });
      expect(result.data).toHaveLength(2);
    });

    it('rejects unsupported format', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      await expect(connector.peek('image.png')).rejects.toThrow(QueryError);
    });

    it('rejects file larger than 50MB', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 60 * 1024 * 1024 });

      await expect(connector.peek('huge.csv')).rejects.toThrow(QueryError);
    });

    it('defaults to 10 rows', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const csvLines = ['id,name'];
      for (let i = 0; i < 20; i++) {
        csvLines.push(`${i},user${i}`);
      }

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 500 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse(csvLines.join('\n')));

      const result = await connector.peek('data.csv');
      expect(result.data).toHaveLength(10);
    });

    it('clamps rows to max 1000', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 100 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('id\n1\n2'));

      const result = await connector.peek('data.csv', { rows: 5000 });
      expect(result.data.length).toBeLessThanOrEqual(1000);
    });

    it('clamps rows to minimum 1 when given 0 or negative', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('id,name\n1,Alice\n2,Bob'));

      const result = await connector.peek('data.csv', { rows: 0 });
      expect(result.data).toHaveLength(1);
    });

    it('throws QueryError when download returns no stream body', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      mockDownload.mockResolvedValueOnce({ readableStreamBody: null });

      await expect(connector.peek('data.csv')).rejects.toThrow(QueryError);
    });

    it('wraps getProperties errors via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.peek('data.csv')).rejects.toThrow(PermissionError);
    });

    it('returns undefined columns when JSON result is empty', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 10 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('[]'));

      const result = await connector.peek('data.json');
      expect(result.data).toHaveLength(0);
      expect(result.columns).toBeUndefined();
    });

    it('infers boolean column type from JSON data', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      mockDownload.mockResolvedValueOnce(
        createMockDownloadResponse(JSON.stringify([{ name: 'Alice', active: true, score: 95 }]))
      );

      const result = await connector.peek('data.json');
      expect(result.columns).toBeDefined();
      const activeCol = result.columns!.find((c) => c.name === 'active');
      expect(activeCol!.type).toBe('boolean');
      const scoreCol = result.columns!.find((c) => c.name === 'score');
      expect(scoreCol!.type).toBe('number');
    });

    it('returns undefined columns when CSV has no columns', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 5 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse(''));

      const result = await connector.peek('data.csv');
      expect(result.columns).toBeUndefined();
    });

    it('wraps download errors in peek via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      const downloadError = Object.assign(new Error('Network failure'), { statusCode: 500 });
      mockDownload.mockRejectedValueOnce(downloadError);

      await expect(connector.peek('data.csv')).rejects.toThrow(QueryError);
    });

    it('re-throws QueryError from peek download catch', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      mockDownload.mockRejectedValueOnce(new QueryError('test query error', { connector: 'test' }));

      await expect(connector.peek('data.csv')).rejects.toThrow(QueryError);
    });

    it('does not leak file content in JSON parse errors', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 50 });
      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('invalid json content'));

      try {
        await connector.peek('bad.json');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).message).not.toContain('invalid json content');
        expect((err as QueryError).cause).toBeUndefined();
      }
    });
  });

  describe('read', () => {
    it('throws when not connected', async () => {
      await expect(connector.read('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns a ReadableStream', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('hello world'));

      const stream = await connector.read('test.txt');
      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('hello world');
    });

    it('throws NotFoundError when blob does not exist (404)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('BlobNotFound'), {
        statusCode: 404,
        code: 'BlobNotFound',
      });
      mockDownload.mockRejectedValueOnce(error);

      await expect(connector.read('missing.txt')).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError when download returns no stream body', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockDownload.mockResolvedValueOnce({ readableStreamBody: null });

      await expect(connector.read('empty.txt')).rejects.toThrow(NotFoundError);
    });

    it('enforces stream limit', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const createHangingStream = () =>
        new Readable({
          read() {
            /* never push data or null */
          },
        });

      // Open MAX_ACTIVE_STREAMS (10) streams
      for (let i = 0; i < 10; i++) {
        mockDownload.mockResolvedValueOnce({
          readableStreamBody: createHangingStream(),
        });
        await connector.read(`file${i}.txt`);
      }

      // 11th should fail
      await expect(connector.read('file10.txt')).rejects.toThrow(QueryError);
    });

    it('wraps non-404 download errors via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Server Error'), { statusCode: 500 });
      mockDownload.mockRejectedValueOnce(error);

      await expect(connector.read('file.txt')).rejects.toThrow(QueryError);
    });

    it('cancel() closes the underlying stream reader', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockDownload.mockResolvedValueOnce(createMockDownloadResponse('data'));

      const stream = await connector.read('test.txt');
      await stream.cancel();
      // Should not throw, resources should be cleaned up
    });
  });

  describe('stat', () => {
    it('throws when not connected', async () => {
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns file info', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockResolvedValueOnce({
        contentLength: 4096,
        lastModified: new Date('2024-06-15T10:30:00Z'),
        contentType: 'text/csv',
      });

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
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });
  });

  describe('write', () => {
    it('throws when not connected', async () => {
      await expect(connector.write('file.txt', 'hello')).rejects.toThrow(ConnectionError);
    });

    it('writes string data', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockUpload.mockResolvedValueOnce({});

      const result = await connector.write('test.txt', 'hello');

      expect(result.path).toBe('test.txt');
      expect(result.size).toBe(5);
      expect(mockUpload).toHaveBeenCalledWith(expect.any(Buffer), 5, {
        blobHTTPHeaders: { blobContentType: 'text/plain' },
      });
    });

    it('writes Buffer data', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockUpload.mockResolvedValueOnce({});

      const result = await connector.write('data.bin', Buffer.from('hello world'));
      expect(result.size).toBe(11);
    });

    it('writes ReadableStream data', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockUploadStream.mockResolvedValueOnce({});
      mockBlockBlobGetProperties.mockResolvedValueOnce({ contentLength: 5 });

      const inputStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('hello'));
          ctrl.close();
        },
      });

      const result = await connector.write('test.txt', inputStream);
      expect(result.path).toBe('test.txt');
      expect(result.size).toBe(5);
      expect(mockUploadStream).toHaveBeenCalledWith(
        expect.anything(),
        4 * 1024 * 1024, // buffer size
        4, // concurrency
        { blobHTTPHeaders: { blobContentType: 'text/plain' } }
      );
    });

    it('infers Content-Type from file extension', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockUpload.mockResolvedValueOnce({});
      await connector.write('data.csv', 'a,b\n1,2');

      expect(mockUpload).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Number), {
        blobHTTPHeaders: { blobContentType: 'text/csv' },
      });
    });

    it('wraps write errors via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      mockUpload.mockRejectedValueOnce(error);

      await expect(connector.write('test.txt', 'hello')).rejects.toThrow(PermissionError);
    });

    it('wraps ReadableStream upload errors via wrapError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Server Error'), { statusCode: 500 });
      mockUploadStream.mockRejectedValueOnce(error);

      const inputStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('hello'));
          ctrl.close();
        },
      });

      await expect(connector.write('test.txt', inputStream)).rejects.toThrow(QueryError);
    });

    it('defaults to application/octet-stream for unknown extensions', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockUpload.mockResolvedValueOnce({});
      await connector.write('data.xyz', 'content');

      expect(mockUpload).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Number), {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      });
    });
  });

  describe('remove', () => {
    it('throws when not connected', async () => {
      await expect(connector.remove('file.txt')).rejects.toThrow(ConnectionError);
    });

    it('deletes a file', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockDeleteBlob.mockResolvedValueOnce(undefined);
      await connector.remove('test.txt');
      expect(mockDeleteBlob).toHaveBeenCalled();
    });

    it('is idempotent (silently handles 404 on delete)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('BlobNotFound'), {
        statusCode: 404,
        code: 'BlobNotFound',
      });
      mockDeleteBlob.mockRejectedValueOnce(error);

      // Should NOT throw -- 404 is silently swallowed for idempotent delete
      await connector.remove('nonexistent.txt');
    });

    it('rethrows non-404 errors', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      mockDeleteBlob.mockRejectedValueOnce(error);

      await expect(connector.remove('secret.txt')).rejects.toThrow(PermissionError);
    });
  });

  describe('error wrapping', () => {
    it('wraps 401 as AuthenticationError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(AuthenticationError);
    });

    it('wraps 403 as PermissionError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('secret.csv')).rejects.toThrow(PermissionError);
    });

    it('wraps 404 as NotFoundError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });

    it('wraps AuthenticationFailed code as AuthenticationError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('AuthenticationFailed'), {
        code: 'AuthenticationFailed',
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(AuthenticationError);
    });

    it('wraps AuthorizationFailure code as PermissionError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('AuthorizationFailure'), {
        code: 'AuthorizationFailure',
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(PermissionError);
    });

    it('wraps ContainerNotFound code as NotFoundError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('ContainerNotFound'), {
        code: 'ContainerNotFound',
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(NotFoundError);
    });

    it('wraps BlobNotFound code as NotFoundError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('BlobNotFound'), {
        code: 'BlobNotFound',
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(NotFoundError);
    });

    it('wraps network errors as ConnectionError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('wraps unknown errors as QueryError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockRejectedValueOnce(new Error('Something unexpected'));
      await expect(connector.stat('file.csv')).rejects.toThrow(QueryError);
    });

    it('sanitizes cause to prevent SAS token leakage', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('Server Error'), {
        statusCode: 500,
        name: 'RestError',
        code: 'ServerError',
        request: { url: 'https://myaccount.blob.core.windows.net?sv=secret-sas-token' },
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      try {
        await connector.stat('file.csv');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        const cause = (err as QueryError).cause as Error & { request?: unknown };
        // Cause should NOT contain the request object with SAS token
        expect(cause).toBeDefined();
        expect(cause.request).toBeUndefined();
        // But should preserve diagnostic fields
        expect(cause.message).toBe('Server Error');
        expect((cause as Error & { statusCode?: number }).statusCode).toBe(500);
        expect((cause as Error & { code?: string }).code).toBe('ServerError');
      }
    });

    it('wraps ENOTFOUND as ConnectionError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockRejectedValueOnce(
        new Error('getaddrinfo ENOTFOUND myaccount.blob.core.windows.net')
      );
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('wraps non-Error thrown values as QueryError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      mockBlockBlobGetProperties.mockRejectedValueOnce('string error');
      await expect(connector.stat('file.csv')).rejects.toThrow(QueryError);
    });

    it('sanitizes cause for non-RestError (plain Error)', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const plainError = new Error('plain error without statusCode');
      mockBlockBlobGetProperties.mockRejectedValueOnce(plainError);

      try {
        await connector.stat('file.csv');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        const cause = (err as QueryError).cause as Error;
        // Plain Error passes through without sanitization
        expect(cause.message).toBe('plain error without statusCode');
      }
    });

    it('wraps InvalidAuthenticationInfo as AuthenticationError', async () => {
      mockContainerGetProperties.mockResolvedValue({});
      await connector.connect();

      const error = Object.assign(new Error('InvalidAuthenticationInfo'), {
        code: 'InvalidAuthenticationInfo',
      });
      mockBlockBlobGetProperties.mockRejectedValueOnce(error);

      await expect(connector.stat('file.csv')).rejects.toThrow(AuthenticationError);
    });
  });

  describe('ensureConnected', () => {
    it('throws ConnectionError when not connected', async () => {
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
      await expect(connector.files()).rejects.toThrow(ConnectionError);
      await expect(connector.peek('file.csv')).rejects.toThrow(ConnectionError);
      await expect(connector.read('file.csv')).rejects.toThrow(ConnectionError);
      await expect(connector.write('file.csv', 'data')).rejects.toThrow(ConnectionError);
      await expect(connector.remove('file.csv')).rejects.toThrow(ConnectionError);
    });
  });
});
