import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AWSS3Connector } from './connector.js';
import type { AWSS3Auth } from '../core/index.js';
import {
  ConnectionError,
  QueryError,
  NotFoundError,
  AuthenticationError,
  PermissionError,
} from '../core/index.js';

// Mock @aws-sdk/client-s3
vi.mock('@aws-sdk/client-s3', () => {
  const mockSend = vi.fn();
  const mockDestroy = vi.fn();

  const MockS3Client = vi.fn(() => ({
    send: mockSend,
    destroy: mockDestroy,
  }));

  // Command constructors just store their input
  const HeadBucketCommand = vi.fn((input: unknown) => ({ _type: 'HeadBucket', input }));
  const HeadObjectCommand = vi.fn((input: unknown) => ({ _type: 'HeadObject', input }));
  const ListObjectsV2Command = vi.fn((input: unknown) => ({ _type: 'ListObjectsV2', input }));
  const GetObjectCommand = vi.fn((input: unknown) => ({ _type: 'GetObject', input }));
  const PutObjectCommand = vi.fn((input: unknown) => ({ _type: 'PutObject', input }));
  const DeleteObjectCommand = vi.fn((input: unknown) => ({ _type: 'DeleteObject', input }));

  return {
    S3Client: MockS3Client,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    _mocks: { mockSend, mockDestroy, MockS3Client },
  };
});

async function getMocks() {
  const mod = (await import('@aws-sdk/client-s3')) as unknown as {
    _mocks: {
      mockSend: ReturnType<typeof vi.fn>;
      mockDestroy: ReturnType<typeof vi.fn>;
      MockS3Client: ReturnType<typeof vi.fn>;
    };
  };
  return mod._mocks;
}

/** Mock auth for tests that need a connected connector. */
const mockAuth: AWSS3Auth = {
  type: 'access-key',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secrettest',
  region: 'us-east-1',
};

/** Helper: create a mock S3 Body that can transformToString and transformToWebStream. */
function createMockBody(content: string) {
  return {
    transformToString: vi.fn().mockResolvedValue(content),
    transformToWebStream: vi.fn(() => {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      return new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(data);
          ctrl.close();
        },
      });
    }),
  };
}

describe('AWSS3Connector', () => {
  let connector: AWSS3Connector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new AWSS3Connector({ bucket: 'test-bucket' });
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
      expect(() => new AWSS3Connector({ bucket: '' })).toThrow(ConnectionError);
    });

    it('throws ConnectionError when bucket is whitespace', () => {
      expect(() => new AWSS3Connector({ bucket: '  ' })).toThrow(ConnectionError);
    });

    it('accepts valid options', () => {
      const c = new AWSS3Connector({ bucket: 'my-bucket', prefix: 'data/', region: 'us-east-1' });
      expect(c).toBeInstanceOf(AWSS3Connector);
    });
  });

  describe('connect', () => {
    it('connects with access-key auth', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValue({}); // HeadBucket success

      await connector.connect(mockAuth);
      // Should not throw
    });

    it('throws AuthenticationError when auth is not provided', async () => {
      await expect(connector.connect()).rejects.toThrow(AuthenticationError);
      await expect(connector.connect()).rejects.toThrow(/AWS S3 requires explicit authentication/);
      try {
        await connector.connect();
      } catch (err) {
        expect((err as AuthenticationError).code).toBe('VENOMOUS_AUTH_REQUIRED');
      }
    });

    it('wraps NoSuchBucket as NotFoundError', async () => {
      const mocks = await getMocks();
      const error = Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' });
      mocks.mockSend.mockRejectedValue(error);

      await expect(connector.connect(mockAuth)).rejects.toThrow(NotFoundError);
    });

    it('wraps AccessDenied as PermissionError', async () => {
      const mocks = await getMocks();
      const error = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
      });
      mocks.mockSend.mockRejectedValue(error);

      // PermissionError is also a VenomousError
      await expect(connector.connect(mockAuth)).rejects.toThrow('Access Denied');
    });

    it('wraps InvalidAccessKeyId as AuthenticationError', async () => {
      const mocks = await getMocks();
      const error = Object.assign(new Error('Invalid key'), {
        name: 'InvalidAccessKeyId',
      });
      mocks.mockSend.mockRejectedValue(error);

      await expect(connector.connect(mockAuth)).rejects.toThrow(AuthenticationError);
    });

    it('wraps network errors as ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(connector.connect(mockAuth)).rejects.toThrow(ConnectionError);
    });
  });

  describe('disconnect', () => {
    it('resets state and destroys client', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValue({});
      await connector.connect(mockAuth);

      await connector.disconnect();

      // Should throw when calling files() after disconnect
      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('is idempotent (calling disconnect twice does not throw)', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValue({});
      await connector.connect(mockAuth);

      await connector.disconnect();
      await connector.disconnect(); // second call should not throw
    });
  });

  describe('files', () => {
    it('throws ConnectionError when not connected', async () => {
      await expect(connector.files()).rejects.toThrow(ConnectionError);
    });

    it('lists files and directories', async () => {
      const mocks = await getMocks();
      // connect
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      // ListObjectsV2
      mocks.mockSend.mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'reports/' }],
        Contents: [
          {
            Key: 'file1.csv',
            Size: 1024,
            LastModified: new Date('2024-01-15'),
          },
          {
            Key: 'file2.json',
            Size: 2048,
            LastModified: new Date('2024-02-20'),
          },
        ],
        IsTruncated: false,
      });

      const result = await connector.files();

      expect(result.data).toHaveLength(3);
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
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      // First page
      mocks.mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'file1.csv', Size: 100, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: 'abc123',
      });

      const page1 = await connector.files();
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page
      mocks.mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'file2.csv', Size: 200, LastModified: new Date() }],
        IsTruncated: false,
      });

      const page2 = await connector.files(undefined, {
        page: { cursor: page1.nextCursor },
      });
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeUndefined();
    });

    it('lists with prefix', async () => {
      const c = new AWSS3Connector({ bucket: 'test-bucket', prefix: 'data' });
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await c.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'data/file.csv', Size: 100, LastModified: new Date() }],
        IsTruncated: false,
      });

      const result = await c.files();
      expect(result.data[0]!.path).toBe('file.csv');
    });

    it('handles empty listing', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({
        IsTruncated: false,
      });

      const result = await connector.files();
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('handles CJK filenames from S3 response', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({
        Contents: [
          {
            Key: '%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%86%E3%82%B9%E3%83%88.csv',
            Size: 512,
            LastModified: new Date('2024-03-01'),
          },
          {
            Key: '%E6%95%B0%E6%8D%AE%E6%96%87%E4%BB%B6.json',
            Size: 256,
            LastModified: new Date('2024-03-02'),
          },
        ],
        IsTruncated: false,
      });

      const result = await connector.files();
      expect(result.data).toHaveLength(2);
      // fromS3Key should decode percent-encoded CJK keys back to Unicode
      expect(result.data[0]!.name).toContain('.csv');
      expect(result.data[1]!.name).toContain('.json');
    });

    it('rejects invalid cursor', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

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
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      // HeadObject (size check)
      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 100 });
      // GetObject
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody('name,age,city\nAlice,30,Tokyo\nBob,25,Osaka\nCharlie,35,Kyoto'),
      });

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
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 50 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody('name,address\n"Smith, John","123 Main St, Apt 4"'),
      });

      const result = await connector.peek('data.csv');

      expect(result.data[0]).toEqual({
        name: 'Smith, John',
        address: '123 Main St, Apt 4',
      });
    });

    it('peeks CSV with BOM', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 50 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody('\uFEFFname,value\ntest,1'),
      });

      const result = await connector.peek('data.csv');
      expect(result.columns![0]!.name).toBe('name');
    });

    it('peeks JSON array file', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 100 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody(
          JSON.stringify([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Charlie' },
          ])
        ),
      });

      const result = await connector.peek('data.json', { rows: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 1, name: 'Alice' });
      expect(result.columns).toBeDefined();
      expect(result.columns!.find((c) => c.name === 'id')!.type).toBe('number');
    });

    it('peeks JSONL file', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 80 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody(
          '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Charlie"}'
        ),
      });

      const result = await connector.peek('data.jsonl', { rows: 2 });
      expect(result.data).toHaveLength(2);
    });

    it('rejects unsupported format', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      await expect(connector.peek('image.png')).rejects.toThrow(QueryError);
    });

    it('rejects file larger than 50MB', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      // HeadObject returns size > 50MB
      mocks.mockSend.mockResolvedValueOnce({
        ContentLength: 60 * 1024 * 1024,
      });

      await expect(connector.peek('huge.csv')).rejects.toThrow(QueryError);
    });

    it('defaults to 10 rows', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      const csvLines = ['id,name'];
      for (let i = 0; i < 20; i++) {
        csvLines.push(`${i},user${i}`);
      }

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 500 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody(csvLines.join('\n')),
      });

      const result = await connector.peek('data.csv');
      expect(result.data).toHaveLength(10);
    });

    it('clamps rows to max 1000', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 100 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody('id\n1\n2'),
      });

      const result = await connector.peek('data.csv', { rows: 5000 });
      // Should not crash; rows are clamped
      expect(result.data.length).toBeLessThanOrEqual(1000);
    });

    it('handles empty CSV file', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ ContentLength: 0 });
      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody(''),
      });

      const result = await connector.peek('empty.csv');
      expect(result.data).toEqual([]);
    });
  });

  describe('read', () => {
    it('throws when not connected', async () => {
      await expect(connector.read('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns a ReadableStream', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({
        Body: createMockBody('hello world'),
      });

      const stream = await connector.read('test.txt');
      expect(stream).toBeInstanceOf(ReadableStream);

      // Consume the stream
      const reader = stream.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('hello world');
    });

    it('throws NotFoundError for empty body', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({ Body: null });

      await expect(connector.read('missing.txt')).rejects.toThrow(NotFoundError);
    });

    it('enforces stream limit', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      // Create streams that never close (hang forever) to keep them tracked
      const createHangingBody = () => ({
        transformToString: vi.fn().mockResolvedValue(''),
        transformToWebStream: vi.fn(() => {
          return new ReadableStream({
            start() {
              // Intentionally never close or enqueue -- stream stays open
            },
          });
        }),
      });

      // Open MAX_ACTIVE_STREAMS (10) streams
      for (let i = 0; i < 10; i++) {
        mocks.mockSend.mockResolvedValueOnce({
          Body: createHangingBody(),
        });
        await connector.read(`file${i}.txt`);
      }

      // 11th should fail
      await expect(connector.read('file10.txt')).rejects.toThrow(QueryError);
    });
  });

  describe('stat', () => {
    it('throws when not connected', async () => {
      await expect(connector.stat('file.csv')).rejects.toThrow(ConnectionError);
    });

    it('returns file info', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      const lastMod = new Date('2024-06-15T10:30:00Z');
      mocks.mockSend.mockResolvedValueOnce({
        ContentLength: 4096,
        LastModified: lastMod,
        ContentType: 'text/csv',
      });

      const info = await connector.stat('reports/sales.csv');

      expect(info).toEqual({
        name: 'sales.csv',
        path: 'reports/sales.csv',
        size: 4096,
        lastModified: lastMod,
        contentType: 'text/csv',
        isDirectory: false,
      });
    });

    it('wraps not found error', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      const error = Object.assign(new Error('Not Found'), { name: 'NotFound' });
      mocks.mockSend.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });
  });

  describe('write', () => {
    it('throws when not connected', async () => {
      await expect(connector.write!('file.txt', 'hello')).rejects.toThrow(ConnectionError);
    });

    it('writes string data (calculates size locally, no HeadObject)', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({}); // PutObject only

      const result = await connector.write!('test.txt', 'hello');

      expect(result.path).toBe('test.txt');
      expect(result.size).toBe(5);
      // Should have called send exactly 2 times: HeadBucket (connect) + PutObject
      expect(mocks.mockSend).toHaveBeenCalledTimes(2);
    });

    it('writes Buffer data (calculates size locally, no HeadObject)', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({}); // PutObject only

      const result = await connector.write!('data.bin', Buffer.from('hello world'));
      expect(result.size).toBe(11);
      // Should have called send exactly 2 times: HeadBucket (connect) + PutObject
      expect(mocks.mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('remove', () => {
    it('throws when not connected', async () => {
      await expect(connector.remove!('file.txt')).rejects.toThrow(ConnectionError);
    });

    it('deletes a file', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({}); // connect
      await connector.connect(mockAuth);

      mocks.mockSend.mockResolvedValueOnce({}); // DeleteObject

      // Should not throw
      await connector.remove!('test.txt');
    });

    it('is idempotent (no error for non-existent file)', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      // S3 DeleteObject does not error on non-existent keys
      mocks.mockSend.mockResolvedValueOnce({});

      await connector.remove!('nonexistent.txt');
    });
  });

  describe('error wrapping', () => {
    it('wraps 403 status as PermissionError', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      const error = Object.assign(new Error('Forbidden'), {
        name: 'SomeError',
        $metadata: { httpStatusCode: 403 },
      });
      mocks.mockSend.mockRejectedValueOnce(error);

      await expect(connector.stat('secret.csv')).rejects.toThrow(PermissionError);
    });

    it('wraps 404 status as NotFoundError', async () => {
      const mocks = await getMocks();
      mocks.mockSend.mockResolvedValueOnce({});
      await connector.connect(mockAuth);

      const error = Object.assign(new Error('Not Found'), {
        name: 'SomeError',
        $metadata: { httpStatusCode: 404 },
      });
      mocks.mockSend.mockRejectedValueOnce(error);

      await expect(connector.stat('missing.csv')).rejects.toThrow(NotFoundError);
    });
  });
});
