import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MongoDBConnector } from './connector.js';
import {
  ConnectionError,
  QueryError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  encodeCursor,
} from '../core/index.js';

// ─── Mock Setup ───────────────────────────────────────────────────────────────

// Mock ObjectId that behaves like the real one
class MockObjectId {
  private hex: string;
  constructor(hex?: string) {
    this.hex = hex ?? 'aabbccddeeff00112233aabb';
  }
  toHexString() {
    return this.hex;
  }
  toString() {
    return this.hex;
  }
}

// Collection mock chain
const mockFind = vi.fn();
const mockSort = vi.fn();
const mockLimit = vi.fn();
const mockToArray = vi.fn();
const mockFindOne = vi.fn();
const mockInsertMany = vi.fn();
const mockUpdateMany = vi.fn();
const mockDeleteMany = vi.fn();

function resetCollectionChain() {
  // find() returns an object with both sort() and limit() for flexible chaining:
  // peek uses: find().limit().toArray()
  // find uses:  find().sort().limit().toArray()
  mockFind.mockReturnValue({ sort: mockSort, limit: mockLimit });
  mockSort.mockReturnValue({ limit: mockLimit });
  mockLimit.mockReturnValue({ toArray: mockToArray });
}

const mockCollection = vi.fn(() => ({
  find: mockFind,
  findOne: mockFindOne,
  insertMany: mockInsertMany,
  updateMany: mockUpdateMany,
  deleteMany: mockDeleteMany,
}));

const mockListCollections = vi.fn(() => ({
  toArray: vi.fn(),
}));

const mockCommand = vi.fn();

const mockDb = {
  collection: mockCollection,
  listCollections: mockListCollections,
  command: mockCommand,
};

const mockConnect = vi.fn();
const mockClose = vi.fn();

const MockMongoClient = vi.fn(() => ({
  connect: mockConnect,
  db: vi.fn(() => mockDb),
  close: mockClose,
}));

vi.mock('mongodb', () => ({
  MongoClient: MockMongoClient,
  ObjectId: MockObjectId,
}));

vi.mock('./auth.js', () => ({
  resolveAuth: vi.fn(async () => ({
    uri: 'mongodb://localhost:27017',
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function connectConnector(connector: MongoDBConnector) {
  mockCommand.mockResolvedValueOnce({ ok: 1 });
  await connector.connect();
}

function createMockObjectId(hex: string) {
  return new MockObjectId(hex);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MongoDBConnector', () => {
  let connector: MongoDBConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new MongoDBConnector({ database: 'test-db' });
    resetCollectionChain();
  });

  afterEach(async () => {
    try {
      await connector.disconnect();
    } catch {
      // ignore
    }
  });

  // ─── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create instance with required database option', () => {
      const c = new MongoDBConnector({ database: 'mydb' });
      expect(c).toBeInstanceOf(MongoDBConnector);
    });

    it('should create instance with all options', () => {
      const c = new MongoDBConnector({
        database: 'mydb',
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
      });
      expect(c).toBeInstanceOf(MongoDBConnector);
    });
  });

  // ─── connect ──────────────────────────────────────────────────────────────

  describe('connect', () => {
    it('should connect successfully with default auth', async () => {
      mockCommand.mockResolvedValueOnce({ ok: 1 });
      await connector.connect();
      // No error = success
    });

    it('should be idempotent - disconnect before reconnecting', async () => {
      mockCommand.mockResolvedValue({ ok: 1 });
      await connector.connect();
      await connector.connect(); // Should disconnect first
      expect(mockClose).toHaveBeenCalled();
    });

    it('should verify connection with ping command', async () => {
      mockCommand.mockResolvedValueOnce({ ok: 1 });
      await connector.connect();
      expect(mockCommand).toHaveBeenCalledWith({ ping: 1 });
    });

    it('should clean up client on connection failure', async () => {
      mockCommand.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      try {
        await connector.connect();
      } catch {
        // expected
      }
      expect(mockClose).toHaveBeenCalled();
    });

    it('should wrap ECONNREFUSED as ConnectionError', async () => {
      mockCommand.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });

    it('should wrap auth code 18 as AuthenticationError', async () => {
      const err = new Error('Authentication failed');
      (err as Error & { code: number }).code = 18;
      mockCommand.mockRejectedValueOnce(err);
      await expect(connector.connect()).rejects.toThrow(AuthenticationError);
    });

    it('should wrap permission code 13 as PermissionError', async () => {
      const err = new Error('Permission denied');
      (err as Error & { code: number }).code = 13;
      mockCommand.mockRejectedValueOnce(err);
      await expect(connector.connect()).rejects.toThrow(PermissionError);
    });

    it('should wrap MongoNetworkError as ConnectionError', async () => {
      const err = new Error('Network error');
      Object.defineProperty(err, 'constructor', { value: { name: 'MongoNetworkError' } });
      mockCommand.mockRejectedValueOnce(err);
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });

    it('should wrap MongoServerSelectionError as ConnectionError', async () => {
      const err = new Error('Server selection timeout');
      Object.defineProperty(err, 'constructor', { value: { name: 'MongoServerSelectionError' } });
      mockCommand.mockRejectedValueOnce(err);
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });

    it('should pass timeout options to MongoClient', async () => {
      const c = new MongoDBConnector({
        database: 'test-db',
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 3000,
      });
      mockCommand.mockResolvedValueOnce({ ok: 1 });
      await c.connect();
      expect(MockMongoClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          connectTimeoutMS: 5000,
          serverSelectionTimeoutMS: 3000,
        })
      );
    });

    it('should use default timeout values when not specified', async () => {
      mockCommand.mockResolvedValueOnce({ ok: 1 });
      await connector.connect();
      expect(MockMongoClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          connectTimeoutMS: 10000,
          serverSelectionTimeoutMS: 10000,
        })
      );
    });
  });

  // ─── disconnect ───────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('should disconnect successfully', async () => {
      await connectConnector(connector);
      await connector.disconnect();
      // Verify subsequent operations throw NotConnected
      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should be idempotent - no error on double disconnect', async () => {
      await connectConnector(connector);
      await connector.disconnect();
      await connector.disconnect(); // Should not throw
    });

    it('should be a no-op on never-connected connector', async () => {
      await connector.disconnect(); // Should not throw
    });

    it('should clear schema cache on disconnect', async () => {
      await connectConnector(connector);
      // Peek to populate cache
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), name: 'test' },
      ]);
      await connector.peek('users');
      // Disconnect clears cache
      await connector.disconnect();
      // Reconnect and peek again - should re-infer fields
      await connectConnector(connector);
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), age: 25 },
      ]);
      const result = await connector.peek('users');
      expect(result.fields).toEqual([{ name: 'age', type: 'NUMBER', nullable: true }]);
    });

    it('should ignore client.close() errors silently', async () => {
      await connectConnector(connector);
      mockClose.mockRejectedValueOnce(new Error('close error'));
      await connector.disconnect(); // Should not throw
    });
  });

  // ─── ensureConnected ──────────────────────────────────────────────────────

  describe('ensureConnected', () => {
    it('should throw ConnectionError when not connected for collections()', async () => {
      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for peek()', async () => {
      await expect(connector.peek('test')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for find()', async () => {
      await expect(connector.find('test')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for getById()', async () => {
      await expect(connector.getById('test', 'id1')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for insert()', async () => {
      await expect(connector.insert('test', [{ data: {} }])).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for update()', async () => {
      await expect(
        connector.update('test', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
          set: { a: 2 },
        })
      ).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected for remove()', async () => {
      await expect(
        connector.remove('test', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
        })
      ).rejects.toThrow(ConnectionError);
    });

    it('should include VENOMOUS_NOT_CONNECTED code in error', async () => {
      try {
        await connector.collections();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError & { code: string }).code).toBe('VENOMOUS_NOT_CONNECTED');
      }
    });
  });

  // ─── collections ──────────────────────────────────────────────────────────

  describe('collections', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should return empty array when no collections', async () => {
      mockListCollections.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([]),
      });
      const result = await connector.collections();
      expect(result).toEqual([]);
    });

    it('should return collection names', async () => {
      mockListCollections.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([
          { name: 'users', type: 'collection' },
          { name: 'orders', type: 'collection' },
        ]),
      });
      const result = await connector.collections();
      expect(result).toEqual([{ name: 'users' }, { name: 'orders' }]);
    });

    it('should filter out system.* collections', async () => {
      mockListCollections.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([
          { name: 'users', type: 'collection' },
          { name: 'system.buckets', type: 'collection' },
          { name: 'system.profile', type: 'collection' },
        ]),
      });
      const result = await connector.collections();
      expect(result).toEqual([{ name: 'users' }]);
    });

    it('should filter out views', async () => {
      mockListCollections.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([
          { name: 'users', type: 'collection' },
          { name: 'user_summary', type: 'view' },
        ]),
      });
      const result = await connector.collections();
      expect(result).toEqual([{ name: 'users' }]);
    });

    it('should wrap errors as VenomousError', async () => {
      mockListCollections.mockReturnValueOnce({
        toArray: vi.fn().mockRejectedValueOnce(new Error('list failed')),
      });
      await expect(connector.collections()).rejects.toThrow(QueryError);
    });
  });

  // ─── peek ─────────────────────────────────────────────────────────────────

  describe('peek', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should return empty data when collection is empty', async () => {
      mockToArray.mockResolvedValueOnce([]);
      const result = await connector.peek('empty_col');
      expect(result).toEqual({ data: [] });
      expect(result.fields).toBeUndefined();
    });

    it('should return documents with _id mapped to id', async () => {
      const objId = createMockObjectId('aabbccddeeff00112233aa01');
      mockToArray.mockResolvedValueOnce([{ _id: objId, name: 'Alice', age: 30 }]);
      const result = await connector.peek('users');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe('aabbccddeeff00112233aa01');
      expect(result.data[0]!.data).toEqual({ name: 'Alice', age: 30 });
      // _id should not appear in data
      expect(result.data[0]!.data).not.toHaveProperty('_id');
    });

    it('should infer field types from documents', async () => {
      mockToArray.mockResolvedValueOnce([
        {
          _id: createMockObjectId('aabbccddeeff00112233aa01'),
          name: 'Alice',
          age: 30,
          active: true,
          joined: new Date('2024-01-01'),
          tags: ['a', 'b'],
          profile: { bio: 'test' },
        },
      ]);
      const result = await connector.peek('users');
      expect(result.fields).toBeDefined();

      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('name')!.type).toBe('STRING');
      expect(fieldMap.get('age')!.type).toBe('NUMBER');
      expect(fieldMap.get('active')!.type).toBe('BOOLEAN');
      expect(fieldMap.get('joined')!.type).toBe('DATE');
      expect(fieldMap.get('tags')!.type).toBe('ARRAY');
      expect(fieldMap.get('profile')!.type).toBe('OBJECT');
      // All fields should be nullable in schema-less database
      for (const field of result.fields!) {
        expect(field.nullable).toBe(true);
      }
    });

    it('should use default rows of 10', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.peek('users');
      expect(mockLimit).toHaveBeenCalledWith(10);
    });

    it('should respect custom rows option', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.peek('users', { rows: 5 });
      expect(mockLimit).toHaveBeenCalledWith(5);
    });

    it('should clamp rows to minimum 1', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.peek('users', { rows: 0 });
      expect(mockLimit).toHaveBeenCalledWith(1);
    });

    it('should clamp rows to maximum 1000', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.peek('users', { rows: 5000 });
      expect(mockLimit).toHaveBeenCalledWith(1000);
    });

    it('should clamp negative rows to 1', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.peek('users', { rows: -10 });
      expect(mockLimit).toHaveBeenCalledWith(1);
    });

    it('should cache inferred fields', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), name: 'Alice' },
      ]);
      const result1 = await connector.peek('users');

      // Second peek with different docs should still return cached fields
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa02'), age: 25 },
      ]);
      resetCollectionChain();
      const result2 = await connector.peek('users');
      expect(result2.fields).toEqual(result1.fields);
    });

    it('should handle documents with string _id', async () => {
      mockToArray.mockResolvedValueOnce([{ _id: 'custom-id-123', name: 'Alice' }]);
      const result = await connector.peek('users');
      expect(result.data[0]!.id).toBe('custom-id-123');
    });

    it('should handle documents with numeric _id', async () => {
      mockToArray.mockResolvedValueOnce([{ _id: 42, name: 'Alice' }]);
      const result = await connector.peek('users');
      expect(result.data[0]!.id).toBe('42');
    });

    it('should handle documents with null _id', async () => {
      mockToArray.mockResolvedValueOnce([{ _id: null, name: 'Alice' }]);
      const result = await connector.peek('users');
      expect(result.data[0]!.id).toBe('');
    });

    it('should handle ObjectId fields in data (detected via toHexString + constructor)', async () => {
      const refId = createMockObjectId('112233445566778899aabbcc');
      // Simulate ObjectId constructor name
      Object.defineProperty(refId, 'constructor', { value: { name: 'ObjectId' } });
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), ref: refId },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('ref')!.type).toBe('OBJECTID');
    });

    it('should handle Buffer fields as BINARY', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), data: Buffer.from('hello') },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('data')!.type).toBe('BINARY');
    });

    it('should handle Uint8Array fields as BINARY', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), data: new Uint8Array([1, 2, 3]) },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('data')!.type).toBe('BINARY');
    });

    it('should skip null/undefined values when inferring types and use first non-null', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), name: null, age: undefined },
        { _id: createMockObjectId('aabbccddeeff00112233aa02'), name: 'Alice', age: 30 },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('name')!.type).toBe('STRING');
      expect(fieldMap.get('age')!.type).toBe('NUMBER');
    });

    it('should wrap errors as QueryError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('query failed'));
      await expect(connector.peek('users')).rejects.toThrow(QueryError);
    });
  });

  // ─── find ─────────────────────────────────────────────────────────────────

  describe('find', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should return empty results when collection is empty', async () => {
      mockToArray.mockResolvedValueOnce([]);
      const result = await connector.find('users');
      expect(result).toEqual({ data: [], nextCursor: undefined, hasMore: false });
    });

    it('should use default page size of 50', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users');
      // Fetches pageSize + 1 to determine hasMore
      expect(mockLimit).toHaveBeenCalledWith(51);
    });

    it('should respect custom page size', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', { page: { size: 10 } });
      expect(mockLimit).toHaveBeenCalledWith(11);
    });

    it('should return documents with _id mapped to id', async () => {
      const objId = createMockObjectId('aabbccddeeff00112233aa01');
      mockToArray.mockResolvedValueOnce([{ _id: objId, name: 'Alice' }]);
      const result = await connector.find('users');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe('aabbccddeeff00112233aa01');
      expect(result.data[0]!.data).toEqual({ name: 'Alice' });
    });

    it('should detect hasMore when extra document exists', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        name: `User ${i}`,
      }));
      mockToArray.mockResolvedValueOnce(docs);
      const result = await connector.find('users');
      expect(result.hasMore).toBe(true);
      expect(result.data).toHaveLength(50);
      expect(result.nextCursor).toBeDefined();
    });

    it('should not have hasMore when result fits in page', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), name: 'Alice' },
      ]);
      const result = await connector.find('users');
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    // ─── find: filter ─────────────────────────────────────────────────────

    it('should apply eq filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'name', operator: 'eq', value: 'Alice' }],
      });
      expect(mockFind).toHaveBeenCalledWith({ name: 'Alice' });
    });

    it('should apply ne filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'name', operator: 'ne', value: 'Bob' }],
      });
      expect(mockFind).toHaveBeenCalledWith({ name: { $ne: 'Bob' } });
    });

    it('should apply gt filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'age', operator: 'gt', value: 18 }],
      });
      expect(mockFind).toHaveBeenCalledWith({ age: { $gt: 18 } });
    });

    it('should apply lt filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'age', operator: 'lt', value: 65 }],
      });
      expect(mockFind).toHaveBeenCalledWith({ age: { $lt: 65 } });
    });

    it('should apply gte filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'score', operator: 'gte', value: 90 }],
      });
      expect(mockFind).toHaveBeenCalledWith({ score: { $gte: 90 } });
    });

    it('should apply lte filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'score', operator: 'lte', value: 100 }],
      });
      expect(mockFind).toHaveBeenCalledWith({ score: { $lte: 100 } });
    });

    it('should apply in filter', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'status', operator: 'in', value: ['active', 'pending'] }],
      });
      expect(mockFind).toHaveBeenCalledWith({ status: { $in: ['active', 'pending'] } });
    });

    it('should reject in filter with non-array value', async () => {
      await expect(
        connector.find('users', {
          filter: [{ field: 'status', operator: 'in', value: 'active' }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('should reject in filter with more than 30 elements', async () => {
      const largeArray = Array.from({ length: 31 }, (_, i) => `val${i}`);
      await expect(
        connector.find('users', {
          filter: [{ field: 'status', operator: 'in', value: largeArray }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('should combine multiple filters on different fields into single object', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [
          { field: 'age', operator: 'gt', value: 18 },
          { field: 'status', operator: 'eq', value: 'active' },
        ],
      });
      expect(mockFind).toHaveBeenCalledWith({
        age: { $gt: 18 },
        status: 'active',
      });
    });

    it('should use $and for multiple conditions on the same field', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [
          { field: 'age', operator: 'gte', value: 18 },
          { field: 'age', operator: 'lte', value: 65 },
        ],
      });
      expect(mockFind).toHaveBeenCalledWith({
        $and: [{ age: { $gte: 18 } }, { age: { $lte: 65 } }],
      });
    });

    // ─── find: orderBy ────────────────────────────────────────────────────

    it('should sort by _id asc by default (no orderBy)', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users');
      expect(mockSort).toHaveBeenCalledWith({ _id: 1 });
    });

    it('should apply asc orderBy with _id tiebreaker', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'asc' }],
      });
      expect(mockSort).toHaveBeenCalledWith({ name: 1, _id: 1 });
    });

    it('should apply desc orderBy with _id tiebreaker always asc', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'age', direction: 'desc' }],
      });
      // _id is always asc (intentional design decision)
      expect(mockSort).toHaveBeenCalledWith({ age: -1, _id: 1 });
    });

    it('should apply multiple orderBy clauses', async () => {
      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [
          { field: 'name', direction: 'asc' },
          { field: 'age', direction: 'desc' },
        ],
      });
      expect(mockSort).toHaveBeenCalledWith({ name: 1, age: -1, _id: 1 });
    });

    // ─── find: cursor pagination ──────────────────────────────────────────

    it('should apply simple cursor filter for _id-only pagination', async () => {
      const _lastId = createMockObjectId('aabbccddeeff00112233aa01');
      const cursor = encodeCursor({
        lastId: { t: 'objectid', v: 'aabbccddeeff00112233aa01' },
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', { page: { cursor } });

      // Should use $gt on _id
      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      expect(findArg).toHaveProperty('_id');
      const idFilter = findArg['_id'] as Record<string, unknown>;
      expect(idFilter).toHaveProperty('$gt');
    });

    it('should apply compound cursor filter with orderBy', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'objectid', v: 'aabbccddeeff00112233aa01' },
        lastSortValues: [{ t: 'string', v: 'Alice' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'asc' }],
        page: { cursor },
      });

      // Should use $or with compound conditions
      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      expect(findArg).toHaveProperty('$or');
    });

    it('should combine cursor filter with existing filter using $and', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'objectid', v: 'aabbccddeeff00112233aa01' },
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'active' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      expect(findArg).toHaveProperty('$and');
    });

    it('should throw QueryError for cursor with missing lastId', async () => {
      const badCursor = encodeCursor({});
      await expect(connector.find('users', { page: { cursor: badCursor } })).rejects.toThrow(
        QueryError
      );
    });

    it('should throw QueryError for cursor with missing lastSortValues when orderBy is present', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'objectid', v: 'aabbccddeeff00112233aa01' },
      });
      await expect(
        connector.find('users', {
          orderBy: [{ field: 'name', direction: 'asc' }],
          page: { cursor },
        })
      ).rejects.toThrow(QueryError);
    });

    it('should throw QueryError for cursor with mismatched lastSortValues length', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'objectid', v: 'aabbccddeeff00112233aa01' },
        lastSortValues: [
          { t: 'string', v: 'Alice' },
          { t: 'number', v: '30' },
        ],
      });
      await expect(
        connector.find('users', {
          orderBy: [{ field: 'name', direction: 'asc' }],
          page: { cursor },
        })
      ).rejects.toThrow(QueryError);
    });

    it('should correctly restore cursor value types', async () => {
      // Test date restoration in cursor
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [{ t: 'date', v: '2024-01-01T00:00:00.000Z' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'created', direction: 'asc' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      expect(orConditions).toBeDefined();
      // First condition: created > lastCreated
      const firstCond = orConditions[0]!;
      const createdFilter = firstCond['created'] as { $gt: unknown };
      expect(createdFilter.$gt).toBeInstanceOf(Date);
    });

    it('should handle number cursor values', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [{ t: 'number', v: '42' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'age', direction: 'asc' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      const firstCond = orConditions[0]!;
      const ageFilter = firstCond['age'] as { $gt: unknown };
      expect(ageFilter.$gt).toBe(42);
    });

    it('should handle boolean cursor values', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [{ t: 'boolean', v: 'true' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'active', direction: 'asc' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      const firstCond = orConditions[0]!;
      const activeFilter = firstCond['active'] as { $gt: unknown };
      expect(activeFilter.$gt).toBe(true);
    });

    it('should handle null cursor values', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [{ t: 'null', v: '' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'deleted', direction: 'asc' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      // Tiebreaker condition: all sort fields equal + _id > lastId
      const tiebreakerCond = orConditions[1]!;
      expect(tiebreakerCond['deleted']).toBeNull();
    });

    it('should use $lt for desc direction in compound cursor filter', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [{ t: 'number', v: '100' }],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [{ field: 'score', direction: 'desc' }],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      const firstCond = orConditions[0]!;
      const scoreFilter = firstCond['score'] as Record<string, unknown>;
      expect(scoreFilter).toHaveProperty('$lt');
      expect(scoreFilter['$lt']).toBe(100);
    });

    it('should build correct compound cursor filter with multiple orderBy fields', async () => {
      const cursor = encodeCursor({
        lastId: { t: 'string', v: 'my-id' },
        lastSortValues: [
          { t: 'string', v: 'Alice' },
          { t: 'number', v: '30' },
        ],
      });

      mockToArray.mockResolvedValueOnce([]);
      await connector.find('users', {
        orderBy: [
          { field: 'name', direction: 'asc' },
          { field: 'age', direction: 'desc' },
        ],
        page: { cursor },
      });

      const findArg = mockFind.mock.calls[0]![0] as Record<string, unknown>;
      const orConditions = (findArg as { $or: Record<string, unknown>[] }).$or;
      expect(orConditions).toHaveLength(3);

      // Condition 1: name > 'Alice'
      expect(orConditions[0]).toHaveProperty('name');
      expect((orConditions[0]!['name'] as Record<string, unknown>)['$gt']).toBe('Alice');

      // Condition 2: name = 'Alice' AND age < 30
      expect(orConditions[1]!['name']).toBe('Alice');
      expect((orConditions[1]!['age'] as Record<string, unknown>)['$lt']).toBe(30);

      // Condition 3 (tiebreaker): name = 'Alice' AND age = 30 AND _id > lastId
      expect(orConditions[2]!['name']).toBe('Alice');
      expect(orConditions[2]!['age']).toBe(30);
      expect(orConditions[2]).toHaveProperty('_id');
    });

    it('should wrap non-QueryError errors as QueryError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('query failed'));
      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should re-throw QueryError as-is', async () => {
      const qErr = new QueryError('invalid query', {
        code: 'VENOMOUS_INVALID_QUERY',
        connector: 'mongodb',
      });
      mockToArray.mockRejectedValueOnce(qErr);
      try {
        await connector.find('users');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(qErr);
      }
    });
  });

  // ─── getById ──────────────────────────────────────────────────────────────

  describe('getById', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should return document when found by ObjectId', async () => {
      const hex = 'aabbccddeeff00112233aa01';
      mockFindOne.mockResolvedValueOnce({
        _id: createMockObjectId(hex),
        name: 'Alice',
      });
      const result = await connector.getById('users', hex);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(hex);
      expect(result!.data).toEqual({ name: 'Alice' });
    });

    it('should query both ObjectId and string for 24-char hex ID', async () => {
      const hex = 'aabbccddeeff00112233aa01';
      mockFindOne.mockResolvedValueOnce(null);
      await connector.getById('users', hex);

      const filter = mockFindOne.mock.calls[0]![0] as Record<string, unknown>;
      expect(filter).toHaveProperty('$or');
      const orConditions = (filter as { $or: Array<Record<string, unknown>> }).$or;
      expect(orConditions).toHaveLength(2);
    });

    it('should query only string for non-ObjectId ID', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      await connector.getById('users', 'my-custom-id');

      const filter = mockFindOne.mock.calls[0]![0] as Record<string, unknown>;
      expect(filter).not.toHaveProperty('$or');
      expect(filter['_id']).toBe('my-custom-id');
    });

    it('should return null when document not found', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      const result = await connector.getById('users', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should throw QueryError for empty ID', async () => {
      await expect(connector.getById('users', '')).rejects.toThrow(QueryError);
    });

    it('should throw QueryError for ID containing slash', async () => {
      await expect(connector.getById('users', 'path/to/doc')).rejects.toThrow(QueryError);
    });

    it('should include VENOMOUS_INVALID_IDENTIFIER code for invalid ID', async () => {
      try {
        await connector.getById('users', '');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code: string }).code).toBe('VENOMOUS_INVALID_IDENTIFIER');
      }
    });

    it('should re-throw QueryError from validateDocumentId as-is', async () => {
      try {
        await connector.getById('users', 'a/b');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as Error).message).toContain('/');
      }
    });

    it('should wrap SDK errors as appropriate VenomousError', async () => {
      mockFindOne.mockRejectedValueOnce(new Error('network error'));
      await expect(connector.getById('users', 'valid-id')).rejects.toThrow(QueryError);
    });
  });

  // ─── insert ───────────────────────────────────────────────────────────────

  describe('insert', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should return empty result for empty docs array', async () => {
      const result = await connector.insert('users', []);
      expect(result).toEqual({ insertedCount: 0, insertedIds: [] });
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should insert documents without IDs (auto-generated)', async () => {
      const autoId = createMockObjectId('aabbccddeeff00112233aa01');
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: autoId },
      });

      const result = await connector.insert('users', [{ data: { name: 'Alice', age: 30 } }]);

      expect(result.insertedCount).toBe(1);
      expect(result.insertedIds).toHaveLength(1);
      expect(result.insertedIds[0]).toBe(String(autoId));
    });

    it('should insert documents with specified string IDs', async () => {
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: 'custom-id' },
      });

      const result = await connector.insert('users', [
        { id: 'custom-id', data: { name: 'Alice' } },
      ]);

      expect(result.insertedCount).toBe(1);
      // Verify _id was set in the mongo document
      const insertedDocs = mockInsertMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(insertedDocs[0]!['_id']).toBe('custom-id');
    });

    it('should convert 24-char hex ID to ObjectId for insert', async () => {
      const hex = 'aabbccddeeff00112233aa01';
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: createMockObjectId(hex) },
      });

      await connector.insert('users', [{ id: hex, data: { name: 'Alice' } }]);

      const insertedDocs = mockInsertMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(insertedDocs[0]!['_id']).toBeInstanceOf(MockObjectId);
    });

    it('should use ordered:false for insertMany', async () => {
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: 'id1' },
      });

      await connector.insert('users', [{ data: { name: 'Alice' } }]);

      expect(mockInsertMany).toHaveBeenCalledWith(expect.any(Array), { ordered: false });
    });

    it('should validate all IDs upfront before inserting', async () => {
      await expect(
        connector.insert('users', [
          { id: 'valid-id', data: { name: 'Alice' } },
          { id: 'invalid/id', data: { name: 'Bob' } },
        ])
      ).rejects.toThrow(QueryError);
      // insertMany should not have been called
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should reject empty string ID', async () => {
      await expect(
        connector.insert('users', [{ id: '', data: { name: 'Alice' } }])
      ).rejects.toThrow(QueryError);
    });

    it('should insert multiple documents', async () => {
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: 'id1', 1: 'id2', 2: 'id3' },
      });

      const result = await connector.insert('users', [
        { data: { name: 'Alice' } },
        { data: { name: 'Bob' } },
        { data: { name: 'Charlie' } },
      ]);

      expect(result.insertedCount).toBe(3);
      expect(result.insertedIds).toEqual(['id1', 'id2', 'id3']);
    });

    it('should batch large inserts and propagate error on partial failure', async () => {
      // First batch succeeds
      mockInsertMany
        .mockResolvedValueOnce({
          insertedIds: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, `id${i}`])),
        })
        // Second batch fails
        .mockRejectedValueOnce(new Error('Write conflict'));

      const docs = Array.from({ length: 1500 }, (_, i) => ({
        data: { name: `User ${i}` },
      }));

      // Should throw, wrapping the original error
      await expect(connector.insert('users', docs)).rejects.toThrow(QueryError);
      // Verify both batches were attempted
      expect(mockInsertMany).toHaveBeenCalledTimes(2);
    });

    it('should handle DuplicateKey error from MongoBulkWriteError', async () => {
      const bulkErr = new Error('E11000 duplicate key');
      Object.defineProperty(bulkErr, 'constructor', { value: { name: 'MongoBulkWriteError' } });
      (bulkErr as Error & { code: number }).code = 11000;

      mockInsertMany.mockRejectedValueOnce(bulkErr);

      try {
        await connector.insert('users', [{ data: { name: 'Alice' } }]);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code: string }).code).toBe('VENOMOUS_DUPLICATE_KEY');
      }
    });

    it('should handle MongoBulkWriteError with DuplicateKey in writeErrors', async () => {
      const bulkErr = new Error('Bulk write failed');
      Object.defineProperty(bulkErr, 'constructor', { value: { name: 'MongoBulkWriteError' } });
      (bulkErr as Error & { writeErrors: Array<{ code: number }> }).writeErrors = [{ code: 11000 }];

      mockInsertMany.mockRejectedValueOnce(bulkErr);

      try {
        await connector.insert('users', [{ data: { name: 'Alice' } }]);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code: string }).code).toBe('VENOMOUS_DUPLICATE_KEY');
      }
    });

    it('should handle non-DuplicateKey MongoBulkWriteError as QueryError', async () => {
      const bulkErr = new Error('Bulk write failed');
      Object.defineProperty(bulkErr, 'constructor', { value: { name: 'MongoBulkWriteError' } });
      (bulkErr as Error & { code: number }).code = 999;

      mockInsertMany.mockRejectedValueOnce(bulkErr);

      try {
        await connector.insert('users', [{ data: { name: 'Alice' } }]);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code?: string }).code).not.toBe('VENOMOUS_DUPLICATE_KEY');
      }
    });

    it('should not include _id in data portion of inserted document', async () => {
      mockInsertMany.mockResolvedValueOnce({
        insertedIds: { 0: 'custom-id' },
      });

      await connector.insert('users', [
        { id: 'custom-id', data: { name: 'Alice', extra: 'data' } },
      ]);

      const insertedDocs = mockInsertMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
      // _id should be set but the data fields should be spread
      expect(insertedDocs[0]!['name']).toBe('Alice');
      expect(insertedDocs[0]!['extra']).toBe('data');
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should update documents matching filter', async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 3 });

      const result = await connector.update('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'inactive' }],
        set: { status: 'active' },
      });

      expect(result.updatedCount).toBe(3);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { status: 'inactive' },
        { $set: { status: 'active' } }
      );
    });

    it('should throw QueryError for empty filter', async () => {
      await expect(
        connector.update('users', {
          filter: [],
          set: { status: 'active' },
        })
      ).rejects.toThrow(QueryError);
    });

    it('should include VENOMOUS_EMPTY_FILTER code for empty filter', async () => {
      try {
        await connector.update('users', {
          filter: [],
          set: { status: 'active' },
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code: string }).code).toBe('VENOMOUS_EMPTY_FILTER');
      }
    });

    it('should use $set semantics (partial update)', async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 });

      await connector.update('users', {
        filter: [{ field: 'name', operator: 'eq', value: 'Alice' }],
        set: { age: 31, city: 'NYC' },
      });

      const updateArg = mockUpdateMany.mock.calls[0]![1] as Record<string, unknown>;
      expect(updateArg).toEqual({ $set: { age: 31, city: 'NYC' } });
    });

    it('should wrap SDK errors as QueryError', async () => {
      mockUpdateMany.mockRejectedValueOnce(new Error('update failed'));
      await expect(
        connector.update('users', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
          set: { a: 2 },
        })
      ).rejects.toThrow(QueryError);
    });

    it('should re-throw QueryError as-is', async () => {
      const qErr = new QueryError('bad query', { connector: 'mongodb' });
      mockUpdateMany.mockRejectedValueOnce(qErr);
      try {
        await connector.update('users', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
          set: { a: 2 },
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(qErr);
      }
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should delete documents matching filter', async () => {
      mockDeleteMany.mockResolvedValueOnce({ deletedCount: 5 });

      const result = await connector.remove('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'deleted' }],
      });

      expect(result.deletedCount).toBe(5);
      expect(mockDeleteMany).toHaveBeenCalledWith({ status: 'deleted' });
    });

    it('should throw QueryError for empty filter', async () => {
      await expect(connector.remove('users', { filter: [] })).rejects.toThrow(QueryError);
    });

    it('should include VENOMOUS_EMPTY_FILTER code for empty filter', async () => {
      try {
        await connector.remove('users', { filter: [] });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError & { code: string }).code).toBe('VENOMOUS_EMPTY_FILTER');
      }
    });

    it('should wrap SDK errors as QueryError', async () => {
      mockDeleteMany.mockRejectedValueOnce(new Error('delete failed'));
      await expect(
        connector.remove('users', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('should re-throw QueryError as-is', async () => {
      const qErr = new QueryError('bad query', { connector: 'mongodb' });
      mockDeleteMany.mockRejectedValueOnce(qErr);
      try {
        await connector.remove('users', {
          filter: [{ field: 'a', operator: 'eq', value: 1 }],
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(qErr);
      }
    });
  });

  // ─── Error Mapping (wrapError) ────────────────────────────────────────────

  describe('error mapping', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should map numeric code 11000 to VENOMOUS_DUPLICATE_KEY', async () => {
      const err = new Error('E11000 duplicate key error');
      (err as Error & { code: number }).code = 11000;
      mockFindOne.mockRejectedValueOnce(err);

      try {
        await connector.getById('users', 'valid-id');
        expect.fail('Should have thrown');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(QueryError);
        expect((thrown as QueryError & { code: string }).code).toBe('VENOMOUS_DUPLICATE_KEY');
      }
    });

    it('should map numeric code 26 to NotFoundError', async () => {
      const err = new Error('Namespace not found');
      (err as Error & { code: number }).code = 26;
      mockFindOne.mockRejectedValueOnce(err);

      await expect(connector.getById('users', 'valid-id')).rejects.toThrow(NotFoundError);
    });

    it('should map MongoInvalidArgumentError to QueryError with VENOMOUS_INVALID_QUERY', async () => {
      const err = new Error('Invalid argument');
      Object.defineProperty(err, 'constructor', { value: { name: 'MongoInvalidArgumentError' } });
      mockToArray.mockRejectedValueOnce(err);

      try {
        await connector.find('users');
        expect.fail('Should have thrown');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(QueryError);
        expect((thrown as QueryError & { code: string }).code).toBe('VENOMOUS_INVALID_QUERY');
      }
    });

    it('should map MongoNetworkTimeoutError to ConnectionError', async () => {
      const err = new Error('Timeout');
      Object.defineProperty(err, 'constructor', {
        value: { name: 'MongoNetworkTimeoutError' },
      });
      mockToArray.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(ConnectionError);
    });

    it('should map ETIMEDOUT in message to ConnectionError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('connect ETIMEDOUT 10.0.0.1'));
      await expect(connector.find('users')).rejects.toThrow(ConnectionError);
    });

    it('should map ENOTFOUND in message to ConnectionError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND unknown.host'));
      await expect(connector.find('users')).rejects.toThrow(ConnectionError);
    });

    it('should map AUTHENTICATION in message to AuthenticationError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('Authentication failed for user'));
      await expect(connector.find('users')).rejects.toThrow(AuthenticationError);
    });

    it('should map CREDENTIAL in message to AuthenticationError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('Bad credential provided'));
      await expect(connector.find('users')).rejects.toThrow(AuthenticationError);
    });

    it('should map NOT AUTHORIZED in message to PermissionError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('not authorized on test'));
      await expect(connector.find('users')).rejects.toThrow(PermissionError);
    });

    it('should map UNAUTHORIZED in message to PermissionError', async () => {
      mockToArray.mockRejectedValueOnce(new Error('Unauthorized access'));
      await expect(connector.find('users')).rejects.toThrow(PermissionError);
    });

    it('should default to QueryError for unknown errors', async () => {
      mockToArray.mockRejectedValueOnce(new Error('something weird happened'));
      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should handle non-Error thrown values', async () => {
      mockToArray.mockRejectedValueOnce('string error');
      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should pass through existing VenomousError subtypes', async () => {
      const connErr = new ConnectionError('already wrapped', { connector: 'mongodb' });
      mockToArray.mockRejectedValueOnce(connErr);

      try {
        await connector.find('users');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(connErr);
      }
    });

    // ─── URI Redaction ──────────────────────────────────────────────────

    it('should redact mongodb:// credentials in error messages', async () => {
      const err = new Error('failed to connect to mongodb://admin:secret@myhost:27017/db');
      mockCommand.mockRejectedValueOnce(err);

      try {
        const c = new MongoDBConnector({ database: 'test-db' });
        await c.connect();
        expect.fail('Should have thrown');
      } catch (thrown) {
        const message = (thrown as Error).message;
        expect(message).not.toContain('admin:secret');
        expect(message).toContain('[REDACTED]');
      }
    });

    it('should redact mongodb+srv:// credentials in error messages', async () => {
      const err = new Error(
        'cannot connect to mongodb+srv://user:p%40ssword@example-cluster.example.net/db'
      );
      mockCommand.mockRejectedValueOnce(err);

      try {
        const c = new MongoDBConnector({ database: 'test-db' });
        await c.connect();
        expect.fail('Should have thrown');
      } catch (thrown) {
        const message = (thrown as Error).message;
        expect(message).not.toContain('user:p%40ssword');
        expect(message).toContain('[REDACTED]');
      }
    });

    it('should redact credentials when password contains @', async () => {
      const err = new Error('failed: mongodb://user:p@ss@host:27017/db');
      mockCommand.mockRejectedValueOnce(err);

      try {
        const c = new MongoDBConnector({ database: 'test-db' });
        await c.connect();
        expect.fail('Should have thrown');
      } catch (thrown) {
        const message = (thrown as Error).message;
        // The enhanced regex should redact everything between :// and the last @
        expect(message).toContain('[REDACTED]@');
        expect(message).not.toContain('user:p');
      }
    });
  });

  // ─── find: cursor generation with orderBy (buildNextCursor branch) ───────

  describe('find cursor generation with orderBy', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should generate nextCursor with lastSortValues when orderBy is present and hasMore is true', async () => {
      // Generate pageSize+1 docs to trigger hasMore=true
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        name: `User ${String(i).padStart(3, '0')}`,
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'asc' }],
      });

      expect(result.hasMore).toBe(true);
      expect(result.data).toHaveLength(50);
      expect(result.nextCursor).toBeDefined();
    });

    it('should generate nextCursor with multiple sort values for compound orderBy', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        name: `User ${i}`,
        age: 20 + i,
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [
          { field: 'name', direction: 'asc' },
          { field: 'age', direction: 'desc' },
        ],
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should generate nextCursor with Date sort values', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        created: new Date(2024, 0, i + 1), // Jan 1..51
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [{ field: 'created', direction: 'asc' }],
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should generate nextCursor with null sort values', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        deleted: null,
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [{ field: 'deleted', direction: 'asc' }],
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should generate nextCursor with boolean sort values', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        active: i % 2 === 0,
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [{ field: 'active', direction: 'asc' }],
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should generate nextCursor with number sort values', async () => {
      const docs = Array.from({ length: 51 }, (_, i) => ({
        _id: createMockObjectId(`aabbccddeeff001122330${String(i).padStart(3, '0')}`),
        score: i * 10,
      }));
      mockToArray.mockResolvedValueOnce(docs);

      const result = await connector.find('users', {
        orderBy: [{ field: 'score', direction: 'desc' }],
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should not generate nextCursor when results fit in page even with orderBy', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), name: 'Alice' },
      ]);

      const result = await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'asc' }],
      });

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });
  });

  // ─── insert: partial failure error message content ───────────────────────

  describe('insert error message content', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should use defaultMessage with inserted count when original error has no message', async () => {
      // When the original error has an empty message, wrapError falls back to defaultMessage
      // which contains the partial success info
      mockInsertMany
        .mockResolvedValueOnce({
          insertedIds: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, `id${i}`])),
        })
        .mockRejectedValueOnce(new Error(''));

      const docs = Array.from({ length: 1500 }, (_, i) => ({
        data: { name: `User ${i}` },
      }));

      try {
        await connector.insert('users', docs);
        expect.fail('Should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('1000 of 1500 inserted before failure');
      }
    });

    it('should include partial success info even when original error has a message', async () => {
      // Fixed: partial success context is now appended to err.message before
      // passing to wrapError, so the info is always visible.
      mockInsertMany.mockRejectedValueOnce(new Error('Write conflict'));

      try {
        await connector.insert('users', [{ data: { name: 'Alice' } }]);
        expect.fail('Should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        // Both the original error message and the partial success info are present
        expect(message).toContain('Write conflict');
        expect(message).toContain('0 of 1 inserted before failure');
      }
    });

    it('should show 0 inserted when first batch fails and error has no message', async () => {
      mockInsertMany.mockRejectedValueOnce(new Error(''));

      try {
        await connector.insert('users', [{ data: { name: 'Alice' } }]);
        expect.fail('Should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('0 of 1 inserted before failure');
      }
    });
  });

  // ─── inferType: Binary constructor name detection ────────────────────────

  describe('inferType edge cases via peek', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should detect Binary constructor name as BINARY type', async () => {
      const binaryLike = { buffer: new Uint8Array([1, 2, 3]) };
      Object.defineProperty(binaryLike, 'constructor', { value: { name: 'Binary' } });
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), blob: binaryLike },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      expect(fieldMap.get('blob')!.type).toBe('BINARY');
    });

    it('should fallback to STRING for unknown types', async () => {
      const symbolLike = Symbol('test');
      mockToArray.mockResolvedValueOnce([
        { _id: createMockObjectId('aabbccddeeff00112233aa01'), sym: symbolLike },
      ]);
      const result = await connector.peek('users');
      const fieldMap = new Map(result.fields!.map((f) => [f.name, f]));
      // Symbol is typeof 'symbol', not caught by any prior condition, falls to STRING
      expect(fieldMap.get('sym')!.type).toBe('STRING');
    });
  });

  // ─── update/remove: null/undefined filter edge cases ─────────────────────

  describe('update and remove with undefined filter', () => {
    beforeEach(async () => {
      await connectConnector(connector);
    });

    it('should throw QueryError when update filter is undefined', async () => {
      await expect(
        connector.update('users', {
          filter: undefined as unknown as import('../core/index.js').DocFilter,
          set: { a: 1 },
        })
      ).rejects.toThrow(QueryError);
    });

    it('should throw QueryError when remove filter is undefined', async () => {
      await expect(
        connector.remove('users', {
          filter: undefined as unknown as import('../core/index.js').DocFilter,
        })
      ).rejects.toThrow(QueryError);
    });
  });
});
