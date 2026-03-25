import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FirestoreConnector } from './connector.js';
import {
  ConnectionError,
  QueryError,
  PermissionError,
  AuthenticationError,
  NotFoundError,
  encodeCursor,
} from '../core/index.js';

// ─── Mock Setup ───────────────────────────────────────────────────────────────

const mockListCollections = vi.fn();
const mockBatchSet = vi.fn();
const mockBatchUpdate = vi.fn();
const mockBatchDelete = vi.fn();
const mockBatchCommit = vi.fn();
const mockBatch = vi.fn(() => ({
  set: mockBatchSet,
  update: mockBatchUpdate,
  delete: mockBatchDelete,
  commit: mockBatchCommit,
}));
const mockAppDelete = vi.fn();

// Mock Firestore Query chain
const mockGet = vi.fn();

// Build a chainable query mock
function createQueryMock() {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  q.where = vi.fn(() => q);
  q.orderBy = vi.fn(() => q);
  q.startAfter = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.get = mockGet;
  return q;
}

let mockQuery = createQueryMock();

// Mock collection reference
const mockColRef = () => {
  const ref = {
    ...mockQuery,
    doc: vi.fn(),
    id: 'test-collection',
  };
  // Reset mockQuery to point to this ref's methods
  mockQuery = ref as unknown as ReturnType<typeof createQueryMock>;
  return ref;
};

let currentColRef: ReturnType<typeof mockColRef>;

// Mock Firestore DB
const mockFirestoreDb = {
  listCollections: mockListCollections,
  collection: vi.fn(() => {
    currentColRef = mockColRef();
    return currentColRef;
  }),
  doc: vi.fn(),
  batch: mockBatch,
};

// Mock firebase-admin
vi.mock('firebase-admin', () => {
  const initializeApp = vi.fn(() => ({
    delete: mockAppDelete,
  }));

  return {
    default: {
      initializeApp,
      credential: {
        applicationDefault: vi.fn(() => 'mock-credential'),
        cert: vi.fn(() => 'mock-cert'),
      },
    },
    initializeApp,
    credential: {
      applicationDefault: vi.fn(() => 'mock-credential'),
      cert: vi.fn(() => 'mock-cert'),
    },
  };
});

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => mockFirestoreDb),
}));

vi.mock('./auth.js', () => ({
  resolveAuth: vi.fn(async () => ({
    credential: 'mock-credential',
    projectId: 'test-project',
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock DocumentSnapshot */
function createMockSnapshot(
  id: string,
  data: Record<string, unknown>,
  opts?: { exists?: boolean; path?: string }
) {
  const path = opts?.path ?? `test-collection/${id}`;
  return {
    id,
    exists: opts?.exists ?? true,
    data: () => data,
    ref: {
      id,
      path,
    },
  };
}

/** Create a mock Timestamp */
function createMockTimestamp(dateStr: string) {
  return {
    toDate: () => new Date(dateStr),
    _seconds: Math.floor(new Date(dateStr).getTime() / 1000),
    _nanoseconds: 0,
  };
}

/** Create a mock GeoPoint */
function createMockGeoPoint(lat: number, lng: number) {
  const gp = Object.create({
    constructor: { name: 'GeoPoint' },
  });
  gp.latitude = lat;
  gp.longitude = lng;
  // Set constructor.name properly
  Object.defineProperty(gp, 'constructor', {
    value: { name: 'GeoPoint' },
    writable: false,
    enumerable: false,
  });
  return gp;
}

/** Create a mock DocumentReference */
function createMockDocRef(path: string) {
  const ref = Object.create({
    constructor: { name: 'DocumentReference' },
  });
  ref.path = path;
  ref.firestore = mockFirestoreDb;
  Object.defineProperty(ref, 'constructor', {
    value: { name: 'DocumentReference' },
    writable: false,
    enumerable: false,
  });
  return ref;
}

/** Connect a connector (common setup) */
async function connectConnector(connector: FirestoreConnector) {
  mockListCollections.mockResolvedValueOnce([]);
  await connector.connect();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FirestoreConnector', () => {
  let connector: FirestoreConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new FirestoreConnector({ projectId: 'test-project' });
    mockBatchCommit.mockResolvedValue(undefined);
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
    it('should create instance with no options', () => {
      const c = new FirestoreConnector();
      expect(c).toBeInstanceOf(FirestoreConnector);
    });

    it('should create instance with projectId', () => {
      const c = new FirestoreConnector({ projectId: 'my-project' });
      expect(c).toBeInstanceOf(FirestoreConnector);
    });

    it('should create instance with projectId and databaseId', () => {
      const c = new FirestoreConnector({ projectId: 'proj', databaseId: 'my-db' });
      expect(c).toBeInstanceOf(FirestoreConnector);
    });
  });

  // ─── connect ──────────────────────────────────────────────────────────────

  describe('connect', () => {
    it('should connect successfully with default auth', async () => {
      mockListCollections.mockResolvedValueOnce([]);
      await connector.connect();
      // No error thrown = success
    });

    it('should connect successfully with explicit auto auth', async () => {
      mockListCollections.mockResolvedValueOnce([]);
      await connector.connect({ type: 'auto' });
    });

    it('should be idempotent - disconnect before reconnecting', async () => {
      mockListCollections.mockResolvedValue([]);
      await connector.connect();
      await connector.connect(); // Should disconnect first, then reconnect
      expect(mockAppDelete).toHaveBeenCalled();
    });

    it('should throw ConnectionError when connection verification fails with ECONNREFUSED', async () => {
      mockListCollections.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });

    it('should throw PermissionError when listCollections fails with permission-denied', async () => {
      const permErr = new Error('Permission denied');
      (permErr as Error & { code: string }).code = 'permission-denied';
      mockListCollections.mockRejectedValueOnce(permErr);
      await expect(connector.connect()).rejects.toThrow(PermissionError);
    });

    it('should clean up app on connection verification failure', async () => {
      mockListCollections.mockRejectedValueOnce(new Error('verify failed'));
      try {
        await connector.connect();
      } catch {
        // expected
      }
      expect(mockAppDelete).toHaveBeenCalled();
    });
  });

  // ─── disconnect ───────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('should be a no-op when not connected', async () => {
      await connector.disconnect(); // Should not throw
    });

    it('should clean up resources when connected', async () => {
      await connectConnector(connector);
      await connector.disconnect();
      expect(mockAppDelete).toHaveBeenCalled();
    });

    it('should allow reconnection after disconnect', async () => {
      await connectConnector(connector);
      await connector.disconnect();
      mockListCollections.mockResolvedValueOnce([]);
      await connector.connect(); // Should succeed
    });
  });

  // ─── ensureConnected ──────────────────────────────────────────────────────

  describe('ensureConnected', () => {
    it('should throw ConnectionError when not connected', async () => {
      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should throw with VENOMOUS_NOT_CONNECTED code', async () => {
      try {
        await connector.collections();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as ConnectionError).code).toBe('VENOMOUS_NOT_CONNECTED');
      }
    });
  });

  // ─── collections ─────────────────────────────────────────────────────────

  describe('collections', () => {
    it('should return collection names', async () => {
      await connectConnector(connector);
      mockListCollections.mockResolvedValueOnce([
        { id: 'users' },
        { id: 'orders' },
        { id: 'products' },
      ]);

      const result = await connector.collections();
      expect(result).toEqual([{ name: 'users' }, { name: 'orders' }, { name: 'products' }]);
    });

    it('should return empty array for empty database', async () => {
      await connectConnector(connector);
      mockListCollections.mockResolvedValueOnce([]);

      const result = await connector.collections();
      expect(result).toEqual([]);
    });

    it('should wrap Firestore errors', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(new Error('Network error'));

      await expect(connector.collections()).rejects.toThrow();
    });
  });

  // ─── peek ─────────────────────────────────────────────────────────────────

  describe('peek', () => {
    it('should return empty data for empty collection', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      const result = await connector.peek('empty-collection');
      expect(result).toEqual({ data: [] });
      expect(result.fields).toBeUndefined();
    });

    it('should return documents with inferred fields', async () => {
      await connectConnector(connector);
      const docs = [
        createMockSnapshot('doc1', { name: 'Alice', age: 30 }),
        createMockSnapshot('doc2', { name: 'Bob', age: 25 }),
      ];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('users');
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 'doc1', data: { name: 'Alice', age: 30 } });
      expect(result.data[1]).toEqual({ id: 'doc2', data: { name: 'Bob', age: 25 } });
      expect(result.fields).toBeDefined();
      expect(result.fields).toContainEqual({ name: 'name', type: 'STRING', nullable: true });
      expect(result.fields).toContainEqual({ name: 'age', type: 'NUMBER', nullable: true });
    });

    it('should use default limit of 10', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      await connector.peek('collection');
      // The limit call should have been made with 10 (default)
      expect(currentColRef.limit).toHaveBeenCalledWith(10);
    });

    it('should respect custom rows option', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      await connector.peek('collection', { rows: 5 });
      expect(currentColRef.limit).toHaveBeenCalledWith(5);
    });

    it('should clamp rows to maximum of 1000', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      await connector.peek('collection', { rows: 5000 });
      expect(currentColRef.limit).toHaveBeenCalledWith(1000);
    });

    it('should clamp rows to minimum of 1', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      await connector.peek('collection', { rows: -5 });
      expect(currentColRef.limit).toHaveBeenCalledWith(1);
    });

    it('should use schemaCache for repeated calls', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { name: 'Alice' })];

      // First call - infers fields
      mockGet.mockResolvedValueOnce({ empty: false, docs });
      const result1 = await connector.peek('users');

      // Second call - should use cache
      mockGet.mockResolvedValueOnce({ empty: false, docs });
      const result2 = await connector.peek('users');

      expect(result1.fields).toEqual(result2.fields);
    });
  });

  // ─── Type Conversion ─────────────────────────────────────────────────────

  describe('type conversion', () => {
    it('should convert Timestamp to ISO 8601 string', async () => {
      await connectConnector(connector);
      const ts = createMockTimestamp('2026-01-15T10:30:00Z');
      const docs = [createMockSnapshot('doc1', { createdAt: ts })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['createdAt']).toBe('2026-01-15T10:30:00.000Z');
    });

    it('should infer Timestamp type as TIMESTAMP from raw snapshot', async () => {
      await connectConnector(connector);
      const ts = createMockTimestamp('2026-01-15T10:30:00Z');
      const docs = [createMockSnapshot('doc1', { createdAt: ts })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const tsField = result.fields?.find((f) => f.name === 'createdAt');
      expect(tsField?.type).toBe('TIMESTAMP');
    });

    it('should convert GeoPoint to latitude/longitude object', async () => {
      await connectConnector(connector);
      const gp = createMockGeoPoint(37.7749, -122.4194);
      const docs = [createMockSnapshot('doc1', { location: gp })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['location']).toEqual({
        latitude: 37.7749,
        longitude: -122.4194,
      });
    });

    it('should infer GeoPoint type as GEOPOINT', async () => {
      await connectConnector(connector);
      const gp = createMockGeoPoint(37.7749, -122.4194);
      const docs = [createMockSnapshot('doc1', { location: gp })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const gpField = result.fields?.find((f) => f.name === 'location');
      expect(gpField?.type).toBe('GEOPOINT');
    });

    it('should convert DocumentReference to path string', async () => {
      await connectConnector(connector);
      const ref = createMockDocRef('users/user123');
      const docs = [createMockSnapshot('doc1', { authorRef: ref })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['authorRef']).toBe('users/user123');
    });

    it('should infer DocumentReference type as REFERENCE', async () => {
      await connectConnector(connector);
      const ref = createMockDocRef('users/user123');
      const docs = [createMockSnapshot('doc1', { authorRef: ref })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const refField = result.fields?.find((f) => f.name === 'authorRef');
      expect(refField?.type).toBe('REFERENCE');
    });

    it('should convert Buffer to base64 string', async () => {
      await connectConnector(connector);
      const buf = Buffer.from('hello world');
      const docs = [createMockSnapshot('doc1', { binary: buf })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['binary']).toBe(buf.toString('base64'));
    });

    it('should infer Buffer type as BYTES', async () => {
      await connectConnector(connector);
      const buf = Buffer.from('hello');
      const docs = [createMockSnapshot('doc1', { binary: buf })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const bytesField = result.fields?.find((f) => f.name === 'binary');
      expect(bytesField?.type).toBe('BYTES');
    });

    it('should recursively convert nested objects', async () => {
      await connectConnector(connector);
      const ts = createMockTimestamp('2026-06-01T00:00:00Z');
      const docs = [
        createMockSnapshot('doc1', {
          metadata: {
            updatedAt: ts,
            tags: ['a', 'b'],
          },
        }),
      ];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const data = result.data[0]!.data['metadata'] as Record<string, unknown>;
      expect(data['updatedAt']).toBe('2026-06-01T00:00:00.000Z');
      expect(data['tags']).toEqual(['a', 'b']);
    });

    it('should recursively convert arrays containing special types', async () => {
      await connectConnector(connector);
      const ts1 = createMockTimestamp('2026-01-01T00:00:00Z');
      const ts2 = createMockTimestamp('2026-02-01T00:00:00Z');
      const docs = [createMockSnapshot('doc1', { dates: [ts1, ts2] })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const dates = result.data[0]!.data['dates'] as string[];
      expect(dates[0]).toBe('2026-01-01T00:00:00.000Z');
      expect(dates[1]).toBe('2026-02-01T00:00:00.000Z');
    });

    it('should handle null values', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { nullField: null, name: 'test' })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['nullField']).toBeNull();
    });

    it('should handle boolean values', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { active: true, deleted: false })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      expect(result.data[0]!.data['active']).toBe(true);
      expect(result.data[0]!.data['deleted']).toBe(false);

      const activeField = result.fields?.find((f) => f.name === 'active');
      expect(activeField?.type).toBe('BOOLEAN');
    });

    it('should infer ARRAY type', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { tags: ['a', 'b', 'c'] })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const arrField = result.fields?.find((f) => f.name === 'tags');
      expect(arrField?.type).toBe('ARRAY');
    });

    it('should infer MAP type for nested objects', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { address: { city: 'Tokyo', zip: '100-0001' } })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      const mapField = result.fields?.find((f) => f.name === 'address');
      expect(mapField?.type).toBe('MAP');
    });

    it('should set all fields as nullable', async () => {
      await connectConnector(connector);
      const docs = [createMockSnapshot('doc1', { name: 'test', age: 25 })];
      mockGet.mockResolvedValueOnce({ empty: false, docs });

      const result = await connector.peek('collection');
      for (const field of result.fields ?? []) {
        expect(field.nullable).toBe(true);
      }
    });
  });

  // ─── find ─────────────────────────────────────────────────────────────────

  describe('find', () => {
    it('should return all documents without filter', async () => {
      await connectConnector(connector);
      const docs = [
        createMockSnapshot('doc1', { name: 'Alice' }),
        createMockSnapshot('doc2', { name: 'Bob' }),
      ];
      mockGet.mockResolvedValueOnce({ docs, empty: false });

      const result = await connector.find('users');
      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should apply filter conditions', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [
          { field: 'age', operator: 'gte', value: 18 },
          { field: 'status', operator: 'eq', value: 'active' },
        ],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('age', '>=', 18);
      expect(currentColRef.where).toHaveBeenCalledWith('status', '==', 'active');
    });

    it('should apply orderBy clauses', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        orderBy: [
          { field: 'name', direction: 'asc' },
          { field: 'createdAt', direction: 'desc' },
        ],
      });

      expect(currentColRef.orderBy).toHaveBeenCalledWith('name', 'asc');
      expect(currentColRef.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should use default page size of 50', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users');
      // Should limit to pageSize + 1 = 51
      expect(currentColRef.limit).toHaveBeenCalledWith(51);
    });

    it('should use custom page size', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', { page: { size: 10 } });
      expect(currentColRef.limit).toHaveBeenCalledWith(11); // size + 1
    });

    it('should detect hasMore correctly when extra document exists', async () => {
      await connectConnector(connector);
      // Return 11 docs for page size 10 -> hasMore = true
      const docs = Array.from({ length: 11 }, (_, i) =>
        createMockSnapshot(`doc${i}`, { name: `User ${i}` })
      );
      mockGet.mockResolvedValueOnce({ docs, empty: false });

      const result = await connector.find('users', { page: { size: 10 } });
      expect(result.data).toHaveLength(10); // Only first 10
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should detect hasMore as false when no extra document', async () => {
      await connectConnector(connector);
      const docs = Array.from({ length: 5 }, (_, i) =>
        createMockSnapshot(`doc${i}`, { name: `User ${i}` })
      );
      mockGet.mockResolvedValueOnce({ docs, empty: false });

      const result = await connector.find('users', { page: { size: 10 } });
      expect(result.data).toHaveLength(5);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should handle cursor-based pagination', async () => {
      await connectConnector(connector);
      const cursor = encodeCursor({ lastDocPath: 'users/doc5' });

      // Mock doc().get() for cursor resolution
      const mockDocSnapshot = createMockSnapshot(
        'doc5',
        { name: 'User 5' },
        {
          path: 'users/doc5',
          exists: true,
        }
      );
      mockFirestoreDb.doc.mockReturnValueOnce({
        get: vi.fn().mockResolvedValueOnce(mockDocSnapshot),
      });

      mockGet.mockResolvedValueOnce({
        docs: [createMockSnapshot('doc6', { name: 'User 6' })],
        empty: false,
      });

      const result = await connector.find('users', {
        page: { cursor },
      });

      expect(result.data).toHaveLength(1);
      expect(mockFirestoreDb.doc).toHaveBeenCalledWith('users/doc5');
    });

    it('should throw QueryError when cursor references deleted document', async () => {
      await connectConnector(connector);
      const cursor = encodeCursor({ lastDocPath: 'users/deleted-doc' });

      const mockDocSnapshot = { exists: false };
      mockFirestoreDb.doc.mockReturnValueOnce({
        get: vi.fn().mockResolvedValueOnce(mockDocSnapshot),
      });

      await expect(connector.find('users', { page: { cursor } })).rejects.toThrow(QueryError);
    });

    it('should throw QueryError when cursor is missing lastDocPath', async () => {
      await connectConnector(connector);
      const cursor = encodeCursor({ someOtherField: 'value' });

      await expect(connector.find('users', { page: { cursor } })).rejects.toThrow(QueryError);
    });

    it('should return empty result for empty collection', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      const result = await connector.find('empty-collection');
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  // ─── getById ──────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('should return document when it exists', async () => {
      await connectConnector(connector);
      const mockSnapshot = createMockSnapshot('user123', { name: 'Alice', age: 30 });
      currentColRef.doc.mockReturnValueOnce({
        get: vi.fn().mockResolvedValueOnce(mockSnapshot),
      });

      // Re-trigger collection mock
      mockFirestoreDb.collection.mockReturnValueOnce(currentColRef);
      const result = await connector.getById('users', 'user123');

      expect(result).toEqual({ id: 'user123', data: { name: 'Alice', age: 30 } });
    });

    it('should return null when document does not exist', async () => {
      await connectConnector(connector);
      const mockSnapshot = {
        exists: false,
        id: 'missing',
        data: () => null,
        ref: { id: 'missing', path: 'users/missing' },
      };
      currentColRef.doc.mockReturnValueOnce({
        get: vi.fn().mockResolvedValueOnce(mockSnapshot),
      });

      mockFirestoreDb.collection.mockReturnValueOnce(currentColRef);
      const result = await connector.getById('users', 'missing');

      expect(result).toBeNull();
    });

    it('should throw QueryError for empty ID', async () => {
      await connectConnector(connector);
      await expect(connector.getById('users', '')).rejects.toThrow(QueryError);
    });

    it('should throw QueryError for ID containing slash', async () => {
      await connectConnector(connector);
      await expect(connector.getById('users', 'invalid/id')).rejects.toThrow(QueryError);
    });

    it('should throw QueryError with VENOMOUS_INVALID_IDENTIFIER code for invalid ID', async () => {
      await connectConnector(connector);
      try {
        await connector.getById('users', '');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).code).toBe('VENOMOUS_INVALID_IDENTIFIER');
      }
    });
  });

  // ─── insert ───────────────────────────────────────────────────────────────

  describe('insert', () => {
    it('should return zero count for empty array', async () => {
      await connectConnector(connector);
      const result = await connector.insert('users', []);
      expect(result).toEqual({ insertedCount: 0, insertedIds: [] });
    });

    it('should insert documents with explicit IDs', async () => {
      await connectConnector(connector);
      currentColRef.doc.mockImplementation((id?: string) => ({
        id: id ?? 'auto-id',
      }));
      mockFirestoreDb.collection.mockReturnValue(currentColRef);

      const result = await connector.insert('users', [
        { id: 'user1', data: { name: 'Alice' } },
        { id: 'user2', data: { name: 'Bob' } },
      ]);

      expect(result.insertedCount).toBe(2);
      expect(result.insertedIds).toEqual(['user1', 'user2']);
      expect(mockBatchSet).toHaveBeenCalledTimes(2);
      expect(mockBatchCommit).toHaveBeenCalledTimes(1);
    });

    it('should insert documents with auto-generated IDs', async () => {
      await connectConnector(connector);
      let callCount = 0;
      currentColRef.doc.mockImplementation((id?: string) => ({
        id: id ?? `auto-${++callCount}`,
      }));
      mockFirestoreDb.collection.mockReturnValue(currentColRef);

      const result = await connector.insert('users', [
        { data: { name: 'Alice' } },
        { data: { name: 'Bob' } },
      ]);

      expect(result.insertedCount).toBe(2);
      expect(result.insertedIds).toEqual(['auto-1', 'auto-2']);
    });

    it('should batch documents in groups of 500', async () => {
      await connectConnector(connector);
      currentColRef.doc.mockImplementation((id?: string) => ({
        id: id ?? 'auto',
      }));
      mockFirestoreDb.collection.mockReturnValue(currentColRef);

      const docs = Array.from({ length: 501 }, (_, i) => ({
        id: `doc${i}`,
        data: { index: i },
      }));

      const result = await connector.insert('users', docs);

      expect(result.insertedCount).toBe(501);
      expect(mockBatch).toHaveBeenCalledTimes(2); // 500 + 1
      expect(mockBatchCommit).toHaveBeenCalledTimes(2);
    });

    it('should throw QueryError for document with empty ID', async () => {
      await connectConnector(connector);
      await expect(connector.insert('users', [{ id: '', data: { name: 'test' } }])).rejects.toThrow(
        QueryError
      );
    });

    it('should throw QueryError for document with ID containing slash', async () => {
      await connectConnector(connector);
      await expect(
        connector.insert('users', [{ id: 'bad/id', data: { name: 'test' } }])
      ).rejects.toThrow(QueryError);
    });

    it('should validate all IDs before writing any document', async () => {
      await connectConnector(connector);
      // Second doc has bad ID - should reject before any batch.set() calls
      await expect(
        connector.insert('users', [
          { id: 'good-id', data: { name: 'Alice' } },
          { id: 'bad/id', data: { name: 'Bob' } },
        ])
      ).rejects.toThrow(QueryError);
      expect(mockBatchSet).not.toHaveBeenCalled();
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('should throw QueryError for empty filter', async () => {
      await connectConnector(connector);
      await expect(
        connector.update('users', { filter: [], set: { name: 'updated' } })
      ).rejects.toThrow(QueryError);
    });

    it('should throw QueryError with VENOMOUS_EMPTY_FILTER code for empty filter', async () => {
      await connectConnector(connector);
      try {
        await connector.update('users', { filter: [], set: { name: 'test' } });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).code).toBe('VENOMOUS_EMPTY_FILTER');
      }
    });

    it('should return zero count when no documents match', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      const result = await connector.update('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'nonexistent' }],
        set: { status: 'active' },
      });

      expect(result).toEqual({ updatedCount: 0 });
    });

    it('should update matching documents', async () => {
      await connectConnector(connector);
      const matchedDocs = [
        createMockSnapshot('doc1', { status: 'inactive' }),
        createMockSnapshot('doc2', { status: 'inactive' }),
      ];
      mockGet.mockResolvedValueOnce({ empty: false, docs: matchedDocs });

      const result = await connector.update('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'inactive' }],
        set: { status: 'active' },
      });

      expect(result.updatedCount).toBe(2);
      expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
      expect(mockBatchCommit).toHaveBeenCalledTimes(1);
    });

    it('should batch updates in groups of 500', async () => {
      await connectConnector(connector);
      const matchedDocs = Array.from({ length: 600 }, (_, i) =>
        createMockSnapshot(`doc${i}`, { value: i })
      );
      mockGet.mockResolvedValueOnce({ empty: false, docs: matchedDocs });

      const result = await connector.update('users', {
        filter: [{ field: 'active', operator: 'eq', value: true }],
        set: { active: false },
      });

      expect(result.updatedCount).toBe(600);
      expect(mockBatch).toHaveBeenCalledTimes(2); // 500 + 100
      expect(mockBatchCommit).toHaveBeenCalledTimes(2);
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('should throw QueryError for empty filter', async () => {
      await connectConnector(connector);
      await expect(connector.remove('users', { filter: [] })).rejects.toThrow(QueryError);
    });

    it('should throw QueryError with VENOMOUS_EMPTY_FILTER code', async () => {
      await connectConnector(connector);
      try {
        await connector.remove('users', { filter: [] });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).code).toBe('VENOMOUS_EMPTY_FILTER');
      }
    });

    it('should return zero count when no documents match', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      const result = await connector.remove('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'deleted' }],
      });

      expect(result).toEqual({ deletedCount: 0 });
    });

    it('should delete matching documents', async () => {
      await connectConnector(connector);
      const matchedDocs = [
        createMockSnapshot('doc1', { status: 'deleted' }),
        createMockSnapshot('doc2', { status: 'deleted' }),
        createMockSnapshot('doc3', { status: 'deleted' }),
      ];
      mockGet.mockResolvedValueOnce({ empty: false, docs: matchedDocs });

      const result = await connector.remove('users', {
        filter: [{ field: 'status', operator: 'eq', value: 'deleted' }],
      });

      expect(result.deletedCount).toBe(3);
      expect(mockBatchDelete).toHaveBeenCalledTimes(3);
      expect(mockBatchCommit).toHaveBeenCalledTimes(1);
    });

    it('should batch deletes in groups of 500', async () => {
      await connectConnector(connector);
      const matchedDocs = Array.from({ length: 1001 }, (_, i) =>
        createMockSnapshot(`doc${i}`, { value: i })
      );
      mockGet.mockResolvedValueOnce({ empty: false, docs: matchedDocs });

      const result = await connector.remove('users', {
        filter: [{ field: 'old', operator: 'eq', value: true }],
      });

      expect(result.deletedCount).toBe(1001);
      expect(mockBatch).toHaveBeenCalledTimes(3); // 500 + 500 + 1
      expect(mockBatchCommit).toHaveBeenCalledTimes(3);
    });
  });

  // ─── buildQuery ───────────────────────────────────────────────────────────

  describe('buildQuery (via find)', () => {
    it('should map eq operator to ==', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'name', operator: 'eq', value: 'Alice' }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('name', '==', 'Alice');
    });

    it('should map ne operator to !=', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'status', operator: 'ne', value: 'deleted' }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('status', '!=', 'deleted');
    });

    it('should map gt operator to >', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'age', operator: 'gt', value: 18 }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('age', '>', 18);
    });

    it('should map lt operator to <', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'age', operator: 'lt', value: 65 }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('age', '<', 65);
    });

    it('should map gte operator to >=', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'score', operator: 'gte', value: 90 }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('score', '>=', 90);
    });

    it('should map lte operator to <=', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'score', operator: 'lte', value: 100 }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('score', '<=', 100);
    });

    it('should map in operator to in', async () => {
      await connectConnector(connector);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      await connector.find('users', {
        filter: [{ field: 'role', operator: 'in', value: ['admin', 'editor'] }],
      });

      expect(currentColRef.where).toHaveBeenCalledWith('role', 'in', ['admin', 'editor']);
    });

    it('should throw QueryError when in operator value is not an array', async () => {
      await connectConnector(connector);

      await expect(
        connector.find('users', {
          filter: [{ field: 'role', operator: 'in', value: 'admin' }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('should throw QueryError when in operator exceeds 30 elements', async () => {
      await connectConnector(connector);
      const values = Array.from({ length: 31 }, (_, i) => `value${i}`);

      await expect(
        connector.find('users', {
          filter: [{ field: 'id', operator: 'in', value: values }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('should allow in operator with exactly 30 elements', async () => {
      await connectConnector(connector);
      const values = Array.from({ length: 30 }, (_, i) => `value${i}`);
      mockGet.mockResolvedValueOnce({ docs: [], empty: true });

      // Should not throw
      await connector.find('users', {
        filter: [{ field: 'id', operator: 'in', value: values }],
      });
    });
  });

  // ─── wrapError ────────────────────────────────────────────────────────────

  describe('error mapping (via various methods)', () => {
    it('should map unauthenticated code to AuthenticationError', async () => {
      await connectConnector(connector);
      const err = new Error('Authentication required');
      (err as Error & { code: string }).code = 'unauthenticated';
      mockListCollections.mockRejectedValueOnce(err);

      await expect(connector.collections()).rejects.toThrow(AuthenticationError);
    });

    it('should map permission-denied code to PermissionError', async () => {
      await connectConnector(connector);
      const err = new Error('Access denied');
      (err as Error & { code: string }).code = 'permission-denied';
      mockListCollections.mockRejectedValueOnce(err);

      await expect(connector.collections()).rejects.toThrow(PermissionError);
    });

    it('should map not-found code to NotFoundError', async () => {
      await connectConnector(connector);
      const err = new Error('Resource missing');
      (err as Error & { code: string }).code = 'not-found';
      mockListCollections.mockRejectedValueOnce(err);

      await expect(connector.collections()).rejects.toThrow(NotFoundError);
    });

    it('should map unavailable code to ConnectionError', async () => {
      await connectConnector(connector);
      const err = new Error('Service unavailable');
      (err as Error & { code: string }).code = 'unavailable';
      mockListCollections.mockRejectedValueOnce(err);

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should map deadline-exceeded code to ConnectionError', async () => {
      await connectConnector(connector);
      const err = new Error('Timeout');
      (err as Error & { code: string }).code = 'deadline-exceeded';
      mockListCollections.mockRejectedValueOnce(err);

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should map failed-precondition code to QueryError', async () => {
      await connectConnector(connector);
      const err = new Error('Index required: https://console.firebase.google.com/...');
      (err as Error & { code: string }).code = 'failed-precondition';
      mockGet.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should map invalid-argument code to QueryError', async () => {
      await connectConnector(connector);
      const err = new Error('Invalid field path');
      (err as Error & { code: string }).code = 'invalid-argument';
      mockGet.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should map resource-exhausted code to QueryError', async () => {
      await connectConnector(connector);
      const err = new Error('Quota exceeded');
      (err as Error & { code: string }).code = 'resource-exhausted';
      mockGet.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should map already-exists code to QueryError', async () => {
      await connectConnector(connector);
      const err = new Error('Document already exists');
      (err as Error & { code: string }).code = 'already-exists';
      mockGet.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should map cancelled code to QueryError', async () => {
      await connectConnector(connector);
      const err = new Error('Operation cancelled');
      (err as Error & { code: string }).code = 'cancelled';
      mockGet.mockRejectedValueOnce(err);

      await expect(connector.find('users')).rejects.toThrow(QueryError);
    });

    it('should map PERMISSION_DENIED in message to PermissionError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('PERMISSION_DENIED: Missing or insufficient permissions.')
      );

      await expect(connector.collections()).rejects.toThrow(PermissionError);
    });

    it('should map UNAUTHENTICATED in message to AuthenticationError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('UNAUTHENTICATED: Request had invalid authentication credentials.')
      );

      await expect(connector.collections()).rejects.toThrow(AuthenticationError);
    });

    it('should map CREDENTIAL in message to AuthenticationError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('Could not load the default CREDENTIAL.')
      );

      await expect(connector.collections()).rejects.toThrow(AuthenticationError);
    });

    it('should map AUTHENTICATION in message to AuthenticationError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('AUTHENTICATION failed for this request.')
      );

      await expect(connector.collections()).rejects.toThrow(AuthenticationError);
    });

    it('should map ECONNREFUSED in message to ConnectionError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8080'));

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should map ETIMEDOUT in message to ConnectionError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(new Error('connect ETIMEDOUT 10.0.0.1:443'));

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should map ENOTFOUND in message to ConnectionError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('getaddrinfo ENOTFOUND firestore.googleapis.com')
      );

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should map UNAVAILABLE in message to ConnectionError', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(
        new Error('14 UNAVAILABLE: The service is currently unavailable')
      );

      await expect(connector.collections()).rejects.toThrow(ConnectionError);
    });

    it('should default to QueryError for unknown errors', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(new Error('Some unknown error'));

      await expect(connector.collections()).rejects.toThrow(QueryError);
    });

    it('should handle non-Error thrown values', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce('string error');

      await expect(connector.collections()).rejects.toThrow(QueryError);
    });

    it('should preserve existing VenomousError subclasses without re-wrapping', async () => {
      await connectConnector(connector);
      const originalError = new QueryError('original', {
        code: 'VENOMOUS_INVALID_CURSOR',
        connector: 'firestore',
      });
      mockGet.mockRejectedValueOnce(originalError);

      try {
        await connector.find('users');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBe(originalError); // Same instance, not re-wrapped
      }
    });

    it('should set connector field to firestore on wrapped errors', async () => {
      await connectConnector(connector);
      mockListCollections.mockRejectedValueOnce(new Error('test error'));

      try {
        await connector.collections();
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as QueryError).connector).toBe('firestore');
      }
    });
  });

  // ─── Factory Function ────────────────────────────────────────────────────

  describe('createFirestoreConnector', () => {
    it('should be importable from index', async () => {
      const { createFirestoreConnector } = await import('./index.js');
      const c = createFirestoreConnector({ projectId: 'test' });
      expect(c).toBeInstanceOf(FirestoreConnector);
    });

    it('should create connector with no options', async () => {
      const { createFirestoreConnector } = await import('./index.js');
      const c = createFirestoreConnector();
      expect(c).toBeInstanceOf(FirestoreConnector);
    });
  });
});
