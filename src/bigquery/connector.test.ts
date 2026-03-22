import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BigQueryConnector } from './connector.js';
import {
  ConnectionError,
  QueryError,
  PermissionError,
  AuthenticationError,
  NotFoundError,
  encodeCursor,
} from '../core/index.js';

// Mock the @google-cloud/bigquery module
vi.mock('@google-cloud/bigquery', () => {
  const mockGetQueryResults = vi.fn();
  const mockCreateQueryJob = vi.fn();
  const mockQuery = vi.fn();
  const mockGetMetadata = vi.fn();
  const mockGetTables = vi.fn();
  const mockInsert = vi.fn();
  const mockGetDatasets = vi.fn();

  const mockTable = vi.fn(() => ({
    getMetadata: mockGetMetadata,
    insert: mockInsert,
  }));

  const mockDataset = vi.fn(() => ({
    getTables: mockGetTables,
    table: mockTable,
  }));

  const MockBigQuery = vi.fn(() => ({
    query: mockQuery,
    dataset: mockDataset,
    createQueryJob: mockCreateQueryJob,
    getDatasets: mockGetDatasets,
    projectId: 'test-project',
  }));

  return {
    BigQuery: MockBigQuery,
    _mocks: {
      mockQuery,
      mockGetMetadata,
      mockGetTables,
      mockTable,
      mockDataset,
      mockCreateQueryJob,
      mockGetQueryResults,
      mockInsert,
      mockGetDatasets,
      MockBigQuery,
    },
  };
});

// Mock resolveProjectId from auth module
vi.mock('./auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./auth.js')>();
  return {
    ...original,
    resolveProjectId: vi.fn(),
  };
});

// Helper to access BigQuery mocks
async function getMocks() {
  const mod = (await import('@google-cloud/bigquery')) as unknown as {
    _mocks: {
      mockQuery: ReturnType<typeof vi.fn>;
      mockGetMetadata: ReturnType<typeof vi.fn>;
      mockGetTables: ReturnType<typeof vi.fn>;
      mockTable: ReturnType<typeof vi.fn>;
      mockDataset: ReturnType<typeof vi.fn>;
      mockCreateQueryJob: ReturnType<typeof vi.fn>;
      mockGetQueryResults: ReturnType<typeof vi.fn>;
      mockInsert: ReturnType<typeof vi.fn>;
      mockGetDatasets: ReturnType<typeof vi.fn>;
      MockBigQuery: ReturnType<typeof vi.fn>;
    };
  };
  return mod._mocks;
}

// Helper to access resolveProjectId mock
async function getResolveProjectIdMock() {
  const authMod = await import('./auth.js');
  return authMod.resolveProjectId as ReturnType<typeof vi.fn>;
}

describe('BigQueryConnector', () => {
  let connector: BigQueryConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new BigQueryConnector({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });
  });

  afterEach(async () => {
    try {
      await connector.disconnect();
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('creates instance with no arguments', () => {
      const c = new BigQueryConnector();
      expect(c).toBeInstanceOf(BigQueryConnector);
    });

    it('creates instance with only projectId', () => {
      const c = new BigQueryConnector({ projectId: 'proj' });
      expect(c).toBeInstanceOf(BigQueryConnector);
    });

    it('creates instance with projectId and datasetId', () => {
      const c = new BigQueryConnector({ projectId: 'proj', datasetId: 'ds' });
      expect(c).toBeInstanceOf(BigQueryConnector);
    });

    it('creates instance with empty options object', () => {
      const c = new BigQueryConnector({});
      expect(c).toBeInstanceOf(BigQueryConnector);
    });
  });

  describe('connect', () => {
    it('connects successfully with default auth (auto) when projectId is provided', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      await connector.connect();
      // Should not throw
    });

    it('connects successfully with explicit auto auth', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      await connector.connect({ type: 'auto' });
    });

    it('wraps connection errors', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(connector.connect()).rejects.toThrow(ConnectionError);
    });

    it('infers projectId from service-account key file when not provided', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockReturnValue('inferred-project');
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector();
      await c.connect({ type: 'service-account', keyFilePath: '/path/to/key.json' });

      expect(resolveProjectIdMock).toHaveBeenCalledWith({
        type: 'service-account',
        keyFilePath: '/path/to/key.json',
      });
    });

    it('infers projectId from service-account-json credentials when not provided', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockReturnValue('json-project');
      mocks.mockQuery.mockResolvedValue([[]]);

      const creds = {
        project_id: 'json-project',
        client_email: 'test@test.iam.gserviceaccount.com',
      };
      const c = new BigQueryConnector();
      await c.connect({ type: 'service-account-json', credentials: creds });

      expect(resolveProjectIdMock).toHaveBeenCalled();
    });

    it('uses SDK projectId for auto mode without explicit projectId', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockReturnValue(undefined); // auto returns undefined
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector();
      await c.connect({ type: 'auto' });

      // Should succeed because mock BigQuery has projectId: 'test-project'
    });

    it('throws ConnectionError when projectId cannot be determined', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockReturnValue(undefined);
      mocks.mockQuery.mockResolvedValue([[]]);

      // Override the mock to return undefined projectId
      mocks.MockBigQuery.mockImplementation(() => ({
        query: mocks.mockQuery,
        dataset: mocks.mockDataset,
        createQueryJob: mocks.mockCreateQueryJob,
        getDatasets: mocks.mockGetDatasets,
        projectId: undefined, // No projectId
      }));

      const c = new BigQueryConnector();
      await expect(c.connect()).rejects.toThrow(ConnectionError);

      // Restore default mock behavior
      mocks.MockBigQuery.mockImplementation(() => ({
        query: mocks.mockQuery,
        dataset: mocks.mockDataset,
        createQueryJob: mocks.mockCreateQueryJob,
        getDatasets: mocks.mockGetDatasets,
        projectId: 'test-project',
      }));
    });

    it('does not call resolveProjectId when projectId is provided in options', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      mocks.mockQuery.mockResolvedValue([[]]);

      await connector.connect();

      expect(resolveProjectIdMock).not.toHaveBeenCalled();
    });

    it('is idempotent: reconnects by disconnecting first', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      await connector.connect();
      // Connect again -- should not throw
      await connector.connect();
    });

    it('wraps resolveProjectId errors via wrapError', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector();
      // The error from resolveProjectId should be wrapped
      await expect(
        c.connect({ type: 'service-account', keyFilePath: '/nonexistent.json' })
      ).rejects.toThrow();
    });
  });

  describe('disconnect', () => {
    it('resets state', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      await connector.connect();
      await connector.disconnect();

      // Should throw when calling tables() after disconnect
      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('clears schemaCache (reconnect requires fresh metadata)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      // Populate cache via tables()
      mocks.mockGetTables.mockResolvedValue([
        [
          {
            id: 'users',
            metadata: {
              schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
              numRows: '100',
            },
          },
        ],
      ]);
      await connector.tables();

      // Disconnect clears cache
      await connector.disconnect();

      // Reconnect
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      // peek() should call getMetadata() since cache was cleared
      mocks.mockQuery.mockResolvedValueOnce([[{ id: 1 }]]);
      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
          numRows: '100',
        },
      ]);

      await connector.peek('users');
      // getMetadata must be called since cache was cleared by disconnect
      expect(mocks.mockGetMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureDatasetReady', () => {
    it('throws ConnectionError when no dataset and tables() is called', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector({ projectId: 'proj' });
      await c.connect();

      await expect(c.tables()).rejects.toThrow(ConnectionError);
      await expect(c.tables()).rejects.toThrow(/No dataset selected/);
    });

    it('throws ConnectionError when no dataset and peek() is called', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector({ projectId: 'proj' });
      await c.connect();

      await expect(c.peek('users')).rejects.toThrow(ConnectionError);
      await expect(c.peek('users')).rejects.toThrow(/No dataset selected/);
    });

    it('throws ConnectionError when no dataset and find() is called', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector({ projectId: 'proj' });
      await c.connect();

      await expect(c.find('users')).rejects.toThrow(ConnectionError);
    });

    it('sql() works without dataset (only needs base connected)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector({ projectId: 'proj' });
      await c.connect();

      const mockJob = {
        getQueryResults: vi.fn().mockResolvedValue([[{ id: 1 }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      for await (const row of c.sql('SELECT 1 AS id')) {
        rows.push(row);
      }

      expect(rows).toEqual([{ id: 1 }]);
    });
  });

  describe('useDataset', () => {
    it('allows tables() after useDataset()', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);

      const c = new BigQueryConnector({ projectId: 'proj' });
      await c.connect();

      c.useDataset('my_dataset');

      mocks.mockGetTables.mockResolvedValue([[]]);
      const tables = await c.tables();
      expect(tables).toEqual([]);
    });

    it('clears schemaCache on dataset switch', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      // Populate cache via tables()
      mocks.mockGetTables.mockResolvedValue([
        [
          {
            id: 'users',
            metadata: {
              schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
              numRows: '100',
            },
          },
        ],
      ]);
      await connector.tables();

      // Switch dataset
      connector.useDataset('other_dataset');

      // peek() should call getMetadata() since cache was cleared
      mocks.mockQuery.mockResolvedValueOnce([[{ id: 1 }]]);
      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
          numRows: '50',
        },
      ]);

      await connector.peek('users');
      expect(mocks.mockGetMetadata).toHaveBeenCalledTimes(1);
    });

    it('throws ConnectionError when not connected', () => {
      expect(() => connector.useDataset('ds')).toThrow(ConnectionError);
    });

    it('throws QueryError for empty string', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      expect(() => connector.useDataset('')).toThrow(QueryError);
      expect(() => connector.useDataset('')).toThrow(/datasetId must not be empty/);
    });
  });

  describe('datasets', () => {
    it('returns datasets for current project', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetDatasets.mockResolvedValue([
        [
          { id: 'dataset_1', metadata: { location: 'US' } },
          { id: 'dataset_2', metadata: { location: 'asia-northeast1' } },
        ],
      ]);

      const datasets = await connector.datasets();
      expect(datasets).toEqual([
        { datasetId: 'dataset_1', location: 'US' },
        { datasetId: 'dataset_2', location: 'asia-northeast1' },
      ]);
    });

    it('uses current client when projectId matches', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetDatasets.mockResolvedValue([[]]);

      await connector.datasets('test-project');
      // Should use existing client's getDatasets, not create a new BigQuery
      // MockBigQuery was called once for connect(), should not be called again
      expect(mocks.MockBigQuery).toHaveBeenCalledTimes(1);
    });

    it('creates temporary client for different projectId', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetDatasets.mockResolvedValue([[]]);

      await connector.datasets('other-project');
      // MockBigQuery should be called twice: once for connect, once for datasets
      expect(mocks.MockBigQuery).toHaveBeenCalledTimes(2);
      // Second call should have the other projectId
      expect(mocks.MockBigQuery.mock.calls[1]![0]).toMatchObject({
        projectId: 'other-project',
      });
    });

    it('returns empty array', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetDatasets.mockResolvedValue([[]]);

      const datasets = await connector.datasets();
      expect(datasets).toEqual([]);
    });

    it('throws ConnectionError when not connected', async () => {
      await expect(connector.datasets()).rejects.toThrow(ConnectionError);
    });
  });

  describe('projects', () => {
    it('returns ACTIVE projects and filters non-ACTIVE', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      // Mock resource-manager module
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockSearchProjectsAsync = vi.fn().mockReturnValue(
        (async function* () {
          yield { projectId: 'proj-1', displayName: 'Project 1', state: 'ACTIVE' };
          yield { projectId: 'proj-2', displayName: 'Project 2', state: 'DELETE_REQUESTED' };
          yield { projectId: 'proj-3', displayName: 'Project 3', state: 'ACTIVE' };
        })()
      );

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: mockSearchProjectsAsync,
          close: mockClose,
        })),
      }));

      const projects = await connector.projects();

      expect(projects).toEqual([
        { projectId: 'proj-1', displayName: 'Project 1', state: 'ACTIVE' },
        { projectId: 'proj-3', displayName: 'Project 3', state: 'ACTIVE' },
      ]);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('returns empty array when no projects', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue((async function* () {})()),
          close: mockClose,
        })),
      }));

      const projects = await connector.projects();
      expect(projects).toEqual([]);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('throws ConnectionError when not connected', async () => {
      await expect(connector.projects()).rejects.toThrow(ConnectionError);
    });

    // Note: The MODULE_NOT_FOUND branch in projects() (dynamic import failure)
    // cannot be reliably unit-tested in Vitest ESM. vi.doMock with a throwing
    // factory is intercepted by Vitest's module system before reaching the
    // dynamic import() call. This branch is covered by the integration test
    // (src/bigquery/integration.test.ts) when @google-cloud/resource-manager
    // is not installed. The ERR_MODULE_NOT_FOUND code path uses identical logic.

    it('calls ProjectsClient.close() even on error (finally)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('PERMISSION_DENIED: some error');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(PermissionError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });
  });

  describe('wrapError', () => {
    it('maps HTTP 403 to PermissionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const err = new Error('Forbidden') as Error & { code: number };
      err.code = 403;
      mocks.mockGetTables.mockRejectedValue(err);

      await expect(connector.tables()).rejects.toThrow(PermissionError);
    });

    it('maps HTTP 401 to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const err = new Error('Unauthorized') as Error & { code: number };
      err.code = 401;
      mocks.mockGetTables.mockRejectedValue(err);

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps gRPC PERMISSION_DENIED to PermissionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('7 PERMISSION_DENIED: Access denied'));

      await expect(connector.tables()).rejects.toThrow(PermissionError);
    });
  });

  describe('tables', () => {
    it('throws ConnectionError when not connected', async () => {
      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('returns table list with schema from table.metadata (no N+1)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockTableObj = {
        id: 'users',
        metadata: {
          schema: {
            fields: [
              { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
              { name: 'name', type: 'STRING', mode: 'NULLABLE', description: 'User name' },
            ],
          },
          numRows: '100',
        },
      };

      mocks.mockGetTables.mockResolvedValue([[mockTableObj]]);

      const tables = await connector.tables();

      expect(tables).toHaveLength(1);
      expect(tables[0]).toEqual({
        name: 'users',
        schema: [
          { name: 'id', type: 'INTEGER', nullable: false },
          { name: 'name', type: 'STRING', nullable: true, description: 'User name' },
        ],
        rowCount: 100,
      });
      // Verify getMetadata() was NOT called by tables() (no N+1)
      expect(mocks.mockGetMetadata).not.toHaveBeenCalled();
    });

    it('handles empty dataset', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockResolvedValue([[]]);

      const tables = await connector.tables();
      expect(tables).toEqual([]);
      expect(mocks.mockGetMetadata).not.toHaveBeenCalled();
    });

    it('handles tables with missing schema (returns empty schema array)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockTableObj = {
        id: 'view_table',
        metadata: {
          // schema is undefined (e.g. VIEW type or insufficient permissions)
          numRows: '42',
        },
      };

      mocks.mockGetTables.mockResolvedValue([[mockTableObj]]);

      const tables = await connector.tables();
      expect(tables).toHaveLength(1);
      expect(tables[0]!.schema).toEqual([]);
      expect(tables[0]!.rowCount).toBe(42);
    });

    it('handles tables with missing numRows', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockTableObj = {
        id: 'sparse_table',
        metadata: {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
          // numRows is not present
        },
      };

      mocks.mockGetTables.mockResolvedValue([[mockTableObj]]);

      const tables = await connector.tables();
      expect(tables[0]!.rowCount).toBeUndefined();
    });

    it('skips tables with no identifiable name', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockTableWithId = {
        id: 'valid_table',
        metadata: { schema: { fields: [] } },
      };
      const mockTableNoId = {
        id: undefined,
        metadata: { tableReference: {} }, // no tableId either
      };

      mocks.mockGetTables.mockResolvedValue([[mockTableWithId, mockTableNoId]]);

      const tables = await connector.tables();
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe('valid_table');
    });

    it('falls back to metadata.tableReference.tableId when table.id is undefined', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockTableObj = {
        id: undefined,
        metadata: {
          tableReference: { tableId: 'fallback_name' },
          schema: { fields: [] },
        },
      };

      mocks.mockGetTables.mockResolvedValue([[mockTableObj]]);

      const tables = await connector.tables();
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe('fallback_name');
    });

    it('populates schemaCache so subsequent peek() skips getMetadata()', async () => {
      const mocks = await getMocks();
      mocks.mockQuery
        .mockResolvedValueOnce([[]]) // connect
        .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]]); // peek query

      await connector.connect();

      // tables() populates cache
      const mockTableObj = {
        id: 'users',
        metadata: {
          schema: {
            fields: [
              { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
              { name: 'name', type: 'STRING', mode: 'NULLABLE' },
            ],
          },
          numRows: '200',
        },
      };
      mocks.mockGetTables.mockResolvedValue([[mockTableObj]]);
      await connector.tables();

      // peek() should use cached metadata, NOT call getMetadata()
      const result = await connector.peek('users', { rows: 5 });

      expect(result.columns).toHaveLength(2);
      expect(result.totalRows).toBe(200);
      // getMetadata() should never have been called -- cache was pre-populated by tables()
      expect(mocks.mockGetMetadata).not.toHaveBeenCalled();
    });
  });

  describe('peek', () => {
    it('throws when not connected', async () => {
      await expect(connector.peek('users')).rejects.toThrow(ConnectionError);
    });

    it('validates table name', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      await expect(connector.peek('invalid table!')).rejects.toThrow(QueryError);
    });

    it('returns preview data with columns', async () => {
      const mocks = await getMocks();
      mocks.mockQuery
        .mockResolvedValueOnce([[]]) // connect validation
        .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]]); // peek query

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [
              { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
              { name: 'name', type: 'STRING', mode: 'NULLABLE' },
            ],
          },
          numRows: '50',
        },
      ]);

      const result = await connector.peek('users', { rows: 5 });

      expect(result.data).toEqual([{ id: 1, name: 'Alice' }]);
      expect(result.columns).toHaveLength(2);
      expect(result.totalRows).toBe(50);
      // Verify only 1 getMetadata() call (not 2 as before the optimization)
      expect(mocks.mockGetMetadata).toHaveBeenCalledTimes(1);
    });

    it('defaults to 10 rows', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([{ schema: { fields: [] } }]);

      await connector.peek('users');

      // Check the query used LIMIT 10
      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('LIMIT 10');
    });

    it('clamps rows to max 1000', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([{ schema: { fields: [] } }]);

      await connector.peek('users', { rows: 5000 });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('LIMIT 1000');
    });

    it('clamps rows minimum to 1', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([{ schema: { fields: [] } }]);

      await connector.peek('users', { rows: -5 });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('LIMIT 1');
    });

    it('returns undefined columns when schema has no fields', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 1 }]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([{ schema: { fields: [] } }]);

      const result = await connector.peek('users');

      // columns should be undefined when schema is empty
      expect(result.columns).toBeUndefined();
    });

    it('returns undefined totalRows when numRows is not available', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 1 }]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
          // numRows not present
        },
      ]);

      const result = await connector.peek('users');

      expect(result.totalRows).toBeUndefined();
    });
  });

  describe('find', () => {
    it('throws when not connected', async () => {
      await expect(connector.find('users')).rejects.toThrow(ConnectionError);
    });

    it('returns paginated results', async () => {
      const mocks = await getMocks();
      mocks.mockQuery
        .mockResolvedValueOnce([[]]) // connect
        .mockResolvedValueOnce([
          // find
          Array.from({ length: 51 }, (_, i) => ({ id: i + 1 })),
        ]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const result = await connector.find('users');

      expect(result.data).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('returns last page without nextCursor', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const result = await connector.find('users');

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('applies where conditions', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'name', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'name', operator: 'eq', value: 'Alice' }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string; params: Record<string, unknown> }>)[0];
      expect(queryObj.query).toContain('WHERE');
      expect(queryObj.params).toEqual({ p0: 'Alice' });
    });

    it('applies order by', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'name', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'desc' }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('ORDER BY `name` DESC');
    });

    it('handles null equality in where', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);

      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'email', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'email', operator: 'eq', value: null }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('IS NULL');
    });

    it('rejects unknown column names', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      await expect(
        connector.find('users', {
          where: [{ field: 'nonexistent', operator: 'eq', value: 1 }],
        })
      ).rejects.toThrow(QueryError);
    });
  });

  describe('sql', () => {
    it('yields rows from query', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const mockJob = {
        getQueryResults: vi
          .fn()
          .mockResolvedValue([[{ id: 1 }, { id: 2 }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      for await (const row of connector.sql('SELECT * FROM users')) {
        rows.push(row);
      }

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('handles parameterized queries with ? placeholders', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const mockJob = {
        getQueryResults: vi.fn().mockResolvedValue([[{ id: 1 }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      for await (const row of connector.sql('SELECT * FROM users WHERE id = ?', [1])) {
        rows.push(row);
      }

      expect(rows).toEqual([{ id: 1 }]);

      const createCall = mocks.mockCreateQueryJob.mock.calls[0] as Array<{
        query: string;
        params: Record<string, unknown>;
      }>;
      expect(createCall[0].query).toContain('@p0');
      expect(createCall[0].params).toEqual({ p0: 1 });
    });

    it('does not replace ? inside single-quoted string literals', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const mockJob = {
        getQueryResults: vi.fn().mockResolvedValue([[{ id: 1 }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      for await (const row of connector.sql(
        "SELECT * FROM users WHERE name LIKE '%test?%' AND id = ?",
        [42]
      )) {
        rows.push(row);
      }

      const createCall = mocks.mockCreateQueryJob.mock.calls[0] as Array<{
        query: string;
        params: Record<string, unknown>;
      }>;
      // The ? inside quotes should remain, only the outside one gets replaced
      expect(createCall[0].query).toBe(
        "SELECT * FROM users WHERE name LIKE '%test?%' AND id = @p0"
      );
      expect(createCall[0].params).toEqual({ p0: 42 });
    });

    it('throws when param count does not match placeholder count', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const iter = connector.sql('SELECT ? + ?', [1]);
      await expect(async () => {
        for await (const _ of iter) {
          // consume
        }
      }).rejects.toThrow(QueryError);
    });

    it('handles multi-page results', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const mockJob = {
        getQueryResults: vi
          .fn()
          .mockResolvedValueOnce([[{ id: 1 }], null, { pageToken: 'next_page' }])
          .mockResolvedValueOnce([[{ id: 2 }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      for await (const row of connector.sql('SELECT * FROM users')) {
        rows.push(row);
      }

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(mockJob.getQueryResults).toHaveBeenCalledTimes(2);
    });
  });

  describe('insert', () => {
    it('throws when not connected', async () => {
      await expect(connector.insert!('users', [{ id: 1 }])).rejects.toThrow(ConnectionError);
    });

    it('returns count for successful insert', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockInsert.mockResolvedValue(undefined);

      const result = await connector.insert!('users', [{ id: 1 }, { id: 2 }]);
      expect(result).toEqual({ insertedCount: 2 });
    });

    it('returns 0 for empty rows array', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const result = await connector.insert!('users', []);
      expect(result).toEqual({ insertedCount: 0 });
    });

    it('validates table name', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(connector.insert!('bad table!', [{ id: 1 }])).rejects.toThrow(QueryError);
    });
  });

  describe('update', () => {
    it('rejects empty where clause', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(
        connector.update!('users', {
          where: [],
          set: { name: 'Bob' },
        })
      ).rejects.toThrow(QueryError);
    });

    it('rejects undefined where at runtime', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      // Simulate runtime JS call without where (bypasses TS type check)
      await expect(
        connector.update!('users', {
          set: { name: 'Bob' },
        } as never)
      ).rejects.toThrow(QueryError);
    });

    it('rejects where: undefined at runtime', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(
        connector.update!('users', {
          where: undefined as never,
          set: { name: 'Bob' },
        })
      ).rejects.toThrow(QueryError);
    });

    it('executes update with where clause', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [
              { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
              { name: 'name', type: 'STRING', mode: 'NULLABLE' },
            ],
          },
        },
      ]);

      const mockJob = {
        getMetadata: vi.fn().mockResolvedValue([
          {
            statistics: { query: { numDmlAffectedRows: '5' } },
          },
        ]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const result = await connector.update!('users', {
        where: [{ field: 'id', operator: 'gt', value: 10 }],
        set: { name: 'Updated' },
      });

      expect(result).toEqual({ updatedCount: 5 });
    });
  });

  describe('remove', () => {
    it('rejects empty where clause', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(
        connector.remove!('users', {
          where: [],
        })
      ).rejects.toThrow(QueryError);
    });

    it('rejects undefined where at runtime', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      // Simulate runtime JS call without where
      await expect(connector.remove!('users', {} as never)).rejects.toThrow(QueryError);
    });

    it('rejects where: undefined at runtime', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(
        connector.remove!('users', {
          where: undefined as never,
        })
      ).rejects.toThrow(QueryError);
    });

    it('executes delete with where clause', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }],
          },
        },
      ]);

      const mockJob = {
        getMetadata: vi.fn().mockResolvedValue([
          {
            statistics: { query: { numDmlAffectedRows: '3' } },
          },
        ]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const result = await connector.remove!('users', {
        where: [{ field: 'id', operator: 'lt', value: 5 }],
      });

      expect(result).toEqual({ deletedCount: 3 });
    });

    it('validates table name', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(
        connector.remove!('bad table!', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
        })
      ).rejects.toThrow(QueryError);
    });
  });

  describe('identifier validation', () => {
    it('rejects table names with spaces', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(connector.peek('my table')).rejects.toThrow(QueryError);
    });

    it('rejects table names with SQL injection', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      await expect(connector.peek('users; DROP TABLE users')).rejects.toThrow(QueryError);
    });

    it('allows valid identifier characters', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([{ schema: { fields: [] } }]);

      // Should not throw for valid identifiers
      await connector.peek('my_table-v2');
    });
  });

  // ==========================================================================
  // Supplementary tests for improved coverage
  // ==========================================================================

  describe('wrapError (additional branches)', () => {
    it('maps HTTP 404 to NotFoundError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const err = new Error('Not found: Table') as Error & { code: number };
      err.code = 404;
      mocks.mockGetTables.mockRejectedValue(err);

      await expect(connector.tables()).rejects.toThrow(NotFoundError);
    });

    it('maps "Not found" message to NotFoundError when no HTTP code', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('Not found: Dataset my_dataset'));

      await expect(connector.tables()).rejects.toThrow(NotFoundError);
    });

    it('maps "notFound" message to NotFoundError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('notFound'));

      await expect(connector.tables()).rejects.toThrow(NotFoundError);
    });

    it('maps "Could not load the default credentials" to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('Could not load the default credentials'));

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps "invalid_grant" to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('invalid_grant: Token expired'));

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps "UNAUTHENTICATED" to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('UNAUTHENTICATED: request expired'));

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps "credentials are required" to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('credentials are required'));

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps "credentials are not valid" to AuthenticationError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('credentials are not valid'));

      await expect(connector.tables()).rejects.toThrow(AuthenticationError);
    });

    it('maps "ECONNREFUSED" to ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('maps "ETIMEDOUT" to ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('connect ETIMEDOUT'));

      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('maps "ENOTFOUND" to ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND bigquery.googleapis.com')
      );

      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('maps "network error" to ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('network error'));

      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('maps "Network Error" to ConnectionError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('Network Error'));

      await expect(connector.tables()).rejects.toThrow(ConnectionError);
    });

    it('maps unknown Error to QueryError as default', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue(new Error('Something unexpected happened'));

      await expect(connector.tables()).rejects.toThrow(QueryError);
    });

    it('maps non-Error thrown value to QueryError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetTables.mockRejectedValue('string error');

      await expect(connector.tables()).rejects.toThrow(QueryError);
    });

    it('uses defaultMessage when Error has no message', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const err = new Error();
      err.message = '';
      mocks.mockGetTables.mockRejectedValue(err);

      await expect(connector.tables()).rejects.toThrow(QueryError);
      await expect(connector.tables()).rejects.toThrow(/Failed to list tables/);
    });
  });

  describe('find (additional branches)', () => {
    it('applies ne operator with non-null value', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'status', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'status', operator: 'ne', value: 'deleted' }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string; params: Record<string, unknown> }>)[0];
      expect(queryObj.query).toContain('!= @p0');
      expect(queryObj.params).toEqual({ p0: 'deleted' });
    });

    it('applies ne operator with null value (IS NOT NULL)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'email', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'email', operator: 'ne', value: null }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('IS NOT NULL');
    });

    it('applies gt operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'age', type: 'INTEGER', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'age', operator: 'gt', value: 18 }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string; params: Record<string, unknown> }>)[0];
      expect(queryObj.query).toContain('> @p0');
      expect(queryObj.params).toEqual({ p0: 18 });
    });

    it('applies lt operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'age', type: 'INTEGER', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'age', operator: 'lt', value: 30 }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('< @p0');
    });

    it('applies gte operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'score', type: 'FLOAT', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'score', operator: 'gte', value: 90.5 }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('>= @p0');
    });

    it('applies lte operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'score', type: 'FLOAT', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'score', operator: 'lte', value: 50 }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('<= @p0');
    });

    it('applies in operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'status', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'status', operator: 'in', value: ['active', 'pending'] }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string; params: Record<string, unknown> }>)[0];
      expect(queryObj.query).toContain('IN UNNEST(@p0)');
      expect(queryObj.params).toEqual({ p0: ['active', 'pending'] });
    });

    it('applies like operator', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'name', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        where: [{ field: 'name', operator: 'like', value: '%alice%' }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string; params: Record<string, unknown> }>)[0];
      expect(queryObj.query).toContain('LIKE @p0');
      expect(queryObj.params).toEqual({ p0: '%alice%' });
    });

    it('applies multiple where conditions with AND', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [
              { name: 'age', type: 'INTEGER', mode: 'NULLABLE' },
              { name: 'status', type: 'STRING', mode: 'NULLABLE' },
            ],
          },
        },
      ]);

      await connector.find('users', {
        where: [
          { field: 'age', operator: 'gte', value: 18 },
          { field: 'status', operator: 'eq', value: 'active' },
        ],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      const queryObj = (queryCall as Array<{ query: string }>)[0];
      expect(queryObj.query).toContain('>= @p0');
      expect(queryObj.query).toContain('= @p1');
      expect(queryObj.query).toContain('AND');
    });

    it('rejects unknown column in ORDER BY', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      await expect(
        connector.find('users', {
          orderBy: [{ field: 'nonexistent_col', direction: 'asc' }],
        })
      ).rejects.toThrow(QueryError);
    });

    it('handles empty orderBy array gracefully', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 1 }]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const result = await connector.find('users', { orderBy: [] });
      expect(result.data).toEqual([{ id: 1 }]);

      // Query should not contain ORDER BY
      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).not.toContain('ORDER BY');
    });

    it('applies ASC direction by default in ORDER BY', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'name', type: 'STRING', mode: 'NULLABLE' }] },
        },
      ]);

      await connector.find('users', {
        orderBy: [{ field: 'name', direction: 'asc' }],
      });

      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('ORDER BY `name` ASC');
    });

    it('continues pagination from cursor', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 51 }, { id: 52 }]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const cursor = encodeCursor({ offset: 50 });
      const result = await connector.find('users', {
        page: { cursor },
      });

      expect(result.data).toEqual([{ id: 51 }, { id: 52 }]);
      expect(result.hasMore).toBe(false);

      // Verify the query used OFFSET 50
      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('OFFSET 50');
    });

    it('throws QueryError for cursor with missing offset', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const cursor = encodeCursor({ pageToken: 'abc' }); // no offset
      await expect(
        connector.find('users', {
          page: { cursor },
        })
      ).rejects.toThrow(QueryError);
      await expect(
        connector.find('users', {
          page: { cursor },
        })
      ).rejects.toThrow(/Invalid cursor/);
    });

    it('wraps find query errors via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery
        .mockResolvedValueOnce([[]])
        .mockRejectedValueOnce(new Error('PERMISSION_DENIED: Access denied'));
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      await expect(connector.find('users')).rejects.toThrow(PermissionError);
    });

    it('applies custom page size', async () => {
      const mocks = await getMocks();
      mocks.mockQuery
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([Array.from({ length: 11 }, (_, i) => ({ id: i }))]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      const result = await connector.find('users', {
        page: { size: 10 },
      });

      expect(result.data).toHaveLength(10);
      expect(result.hasMore).toBe(true);

      // Verify LIMIT is pageSize + 1 (11)
      const queryCall = mocks.mockQuery.mock.calls[1];
      expect((queryCall as Array<{ query: string }>)[0].query).toContain('LIMIT 11');
    });
  });

  describe('insert (additional branches)', () => {
    it('throws QueryError with partial failure details', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      // Simulate PartialFailureError from BigQuery SDK
      const partialErr = new Error('Partial insert failure') as Error & {
        errors: Array<{ row: number }>;
      };
      partialErr.errors = [
        { row: 0 },
        { row: 0 }, // duplicate row index -- should be deduplicated
        { row: 2 },
      ];
      mocks.mockInsert.mockRejectedValue(partialErr);

      await expect(connector.insert!('users', [{ id: 1 }, { id: 2 }, { id: 3 }])).rejects.toThrow(
        QueryError
      );
      await expect(connector.insert!('users', [{ id: 1 }, { id: 2 }, { id: 3 }])).rejects.toThrow(
        /Partial insert failure/
      );
    });

    it('correctly counts failed rows by deduplicating row indices', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const partialErr = new Error('Partial failure') as Error & {
        errors: Array<{ row: number }>;
      };
      // 3 error entries but only 2 unique row indices
      partialErr.errors = [{ row: 1 }, { row: 1 }, { row: 2 }];
      mocks.mockInsert.mockRejectedValue(partialErr);

      try {
        await connector.insert!('users', [{ id: 1 }, { id: 2 }, { id: 3 }]);
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        expect((err as Error).message).toContain('1/3 rows inserted');
        expect((err as Error).message).toContain('2 failed');
      }
    });

    it('handles partial failure with undefined row indices (falls back to Set size)', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const partialErr = new Error('Partial failure') as Error & {
        errors: Array<Record<string, unknown>>;
      };
      // errors without row property -- all map to undefined, Set({undefined}) size = 1
      partialErr.errors = [{ message: 'error 1' }, { message: 'error 2' }];
      mocks.mockInsert.mockRejectedValue(partialErr);

      try {
        await connector.insert!('users', [{ id: 1 }, { id: 2 }, { id: 3 }]);
      } catch (err) {
        expect(err).toBeInstanceOf(QueryError);
        // Set({undefined}).size = 1 > 0, so failedCount = 1, insertedCount = 3-1 = 2
        expect((err as Error).message).toContain('2/3 rows inserted');
        expect((err as Error).message).toContain('1 failed');
      }
    });
  });

  describe('insert (non-partial error)', () => {
    it('wraps non-partial insert errors via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      // Error without .errors array -- goes to wrapError fallback
      mocks.mockInsert.mockRejectedValue(new Error('PERMISSION_DENIED: Cannot insert'));

      await expect(connector.insert!('users', [{ id: 1 }])).rejects.toThrow(PermissionError);
    });
  });

  describe('update (additional branches)', () => {
    it('rejects unknown column in SET clause', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }],
          },
        },
      ]);

      await expect(
        connector.update!('users', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
          set: { nonexistent_col: 'value' },
        })
      ).rejects.toThrow(QueryError);
      await expect(
        connector.update!('users', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
          set: { nonexistent_col: 'value' },
        })
      ).rejects.toThrow(/Unknown column in SET/);
    });

    it('throws ConnectionError when not connected', async () => {
      await expect(
        connector.update!('users', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
          set: { name: 'test' },
        })
      ).rejects.toThrow(ConnectionError);
    });
  });

  describe('projects (additional error branches)', () => {
    it('throws AuthenticationError for UNAUTHENTICATED gRPC error', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('16 UNAUTHENTICATED: Request had invalid credentials');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(AuthenticationError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('throws ConnectionError for ECONNREFUSED during project listing', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('connect ECONNREFUSED 127.0.0.1:443');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(ConnectionError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('throws ConnectionError for ETIMEDOUT during project listing', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('connect ETIMEDOUT');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(ConnectionError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('throws ConnectionError for ENOTFOUND during project listing', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('getaddrinfo ENOTFOUND cloudresourcemanager.googleapis.com');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(ConnectionError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    it('falls through to wrapError for non-classified errors', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              throw new Error('Some unexpected resource manager error');
            })()
          ),
          close: mockClose,
        })),
      }));

      await expect(connector.projects()).rejects.toThrow(QueryError);
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@google-cloud/resource-manager');
    });

    // Note: Testing re-throw of non-MODULE_NOT_FOUND import errors is not
    // feasible in Vitest ESM because vi.doMock factory-throw is intercepted
    // by Vitest's module system. This path is covered by integration tests.

    it('handles displayName being undefined', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const mockClose = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@google-cloud/resource-manager', () => ({
        ProjectsClient: vi.fn().mockImplementation(() => ({
          searchProjectsAsync: vi.fn().mockReturnValue(
            (async function* () {
              yield { projectId: 'proj-1', displayName: undefined, state: 'ACTIVE' };
            })()
          ),
          close: mockClose,
        })),
      }));

      const projects = await connector.projects();
      expect(projects).toEqual([{ projectId: 'proj-1', displayName: '', state: 'ACTIVE' }]);

      vi.doUnmock('@google-cloud/resource-manager');
    });
  });

  describe('datasets (additional branches)', () => {
    it('wraps errors from getDatasets via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      const err = new Error('Forbidden') as Error & { code: number };
      err.code = 403;
      mocks.mockGetDatasets.mockRejectedValue(err);

      await expect(connector.datasets()).rejects.toThrow(PermissionError);
    });

    it('handles datasets with missing location metadata', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValue([[]]);
      await connector.connect();

      mocks.mockGetDatasets.mockResolvedValue([[{ id: 'ds_no_location', metadata: {} }]]);

      const datasets = await connector.datasets();
      expect(datasets).toEqual([{ datasetId: 'ds_no_location', location: undefined }]);
    });
  });

  describe('sql (additional branches)', () => {
    it('handles escaped single quotes in SQL string literals', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      const mockJob = {
        getQueryResults: vi
          .fn()
          .mockResolvedValue([[{ name: "O'Brien" }], null, { pageToken: undefined }]),
      };
      mocks.mockCreateQueryJob.mockResolvedValue([mockJob]);

      const rows: Array<Record<string, unknown>> = [];
      // SQL with escaped quotes ('') and a ? placeholder outside
      for await (const row of connector.sql(
        "SELECT * FROM users WHERE name = 'O''Brien''s' AND id = ?",
        [42]
      )) {
        rows.push(row);
      }

      const createCall = mocks.mockCreateQueryJob.mock.calls[0] as Array<{
        query: string;
        params: Record<string, unknown>;
      }>;
      // The ? inside single quotes should remain, and escaped quotes preserved
      expect(createCall[0].query).toBe(
        "SELECT * FROM users WHERE name = 'O''Brien''s' AND id = @p0"
      );
      expect(createCall[0].params).toEqual({ p0: 42 });
    });

    it('wraps errors from createQueryJob', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockCreateQueryJob.mockRejectedValue(new Error('Something went wrong'));

      const iter = connector.sql('SELECT * FROM users');
      await expect(async () => {
        for await (const _ of iter) {
          // consume
        }
      }).rejects.toThrow(QueryError);
    });

    it('throws ConnectionError when not connected', async () => {
      const iter = connector.sql('SELECT 1');
      await expect(async () => {
        for await (const _ of iter) {
          // consume
        }
      }).rejects.toThrow(ConnectionError);
    });
  });

  describe('connect (additional cleanup verification)', () => {
    it('cleans up authOptions on validation query failure', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));

      try {
        await connector.connect();
      } catch {
        // expected
      }

      // After failed connect, calling datasets() should throw ConnectionError (not connected)
      await expect(connector.datasets()).rejects.toThrow(ConnectionError);
      await expect(connector.datasets()).rejects.toThrow(/Not connected/);
    });

    it('cleans up authOptions when projectId cannot be determined', async () => {
      const mocks = await getMocks();
      const resolveProjectIdMock = await getResolveProjectIdMock();
      resolveProjectIdMock.mockReturnValue(undefined);
      mocks.mockQuery.mockResolvedValue([[]]);

      mocks.MockBigQuery.mockImplementation(() => ({
        query: mocks.mockQuery,
        dataset: mocks.mockDataset,
        createQueryJob: mocks.mockCreateQueryJob,
        getDatasets: mocks.mockGetDatasets,
        projectId: undefined,
      }));

      const c = new BigQueryConnector();
      try {
        await c.connect();
      } catch {
        // expected
      }

      // After failed connect, calling datasets() should throw ConnectionError
      await expect(c.datasets()).rejects.toThrow(ConnectionError);
      await expect(c.datasets()).rejects.toThrow(/Not connected/);

      // Restore mock
      mocks.MockBigQuery.mockImplementation(() => ({
        query: mocks.mockQuery,
        dataset: mocks.mockDataset,
        createQueryJob: mocks.mockCreateQueryJob,
        getDatasets: mocks.mockGetDatasets,
        projectId: 'test-project',
      }));
    });
  });

  describe('peek (additional branches)', () => {
    it('wraps getMetadata errors via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 1 }]]);
      await connector.connect();

      const err = new Error('Not found: Table users') as Error & { code: number };
      err.code = 404;
      mocks.mockGetMetadata.mockRejectedValue(err);

      await expect(connector.peek('users')).rejects.toThrow(NotFoundError);
    });
  });

  describe('remove (additional branches)', () => {
    it('wraps DML errors via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
        },
      ]);

      mocks.mockCreateQueryJob.mockRejectedValue(new Error('PERMISSION_DENIED: Access denied'));

      await expect(
        connector.remove!('users', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
        })
      ).rejects.toThrow(PermissionError);
    });
  });

  describe('update (error wrapping)', () => {
    it('wraps DML errors via wrapError', async () => {
      const mocks = await getMocks();
      mocks.mockQuery.mockResolvedValueOnce([[]]);
      await connector.connect();

      mocks.mockGetMetadata.mockResolvedValue([
        {
          schema: {
            fields: [
              { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
              { name: 'name', type: 'STRING', mode: 'NULLABLE' },
            ],
          },
        },
      ]);

      mocks.mockCreateQueryJob.mockRejectedValue(new Error('PERMISSION_DENIED: Access denied'));

      await expect(
        connector.update!('users', {
          where: [{ field: 'id', operator: 'eq', value: 1 }],
          set: { name: 'test' },
        })
      ).rejects.toThrow(PermissionError);
    });
  });
});
