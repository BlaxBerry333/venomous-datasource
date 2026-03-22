import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError } from '../core/index.js';

// Mock @azure/storage-blob
const MockBlobServiceClient = vi.fn();
const MockStorageSharedKeyCredential = vi.fn();
MockBlobServiceClient.fromConnectionString = vi.fn(() => ({ mock: 'from-conn-string' }));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: MockBlobServiceClient,
  StorageSharedKeyCredential: MockStorageSharedKeyCredential,
}));

// Mock @azure/identity
const MockDefaultAzureCredential = vi.fn();
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: MockDefaultAzureCredential,
}));

// Import after mocks
const { resolveAuth } = await import('./auth.js');

describe('resolveAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockBlobServiceClient.mockImplementation(() => ({ mock: 'client' }));
    MockStorageSharedKeyCredential.mockImplementation(() => ({ mock: 'key-cred' }));
    MockDefaultAzureCredential.mockImplementation(() => ({ mock: 'default-cred' }));
  });

  describe('auto mode', () => {
    it('creates client with DefaultAzureCredential when auth is auto', async () => {
      const result = await resolveAuth({ type: 'auto' }, 'myaccount');

      expect(result.client).toBeDefined();
      expect(MockDefaultAzureCredential).toHaveBeenCalledOnce();
      expect(MockBlobServiceClient).toHaveBeenCalledWith(
        'https://myaccount.blob.core.windows.net',
        expect.anything()
      );
    });

    it('creates client with DefaultAzureCredential when auth is undefined', async () => {
      const result = await resolveAuth(undefined, 'myaccount');

      expect(result.client).toBeDefined();
      expect(MockDefaultAzureCredential).toHaveBeenCalledOnce();
    });

    it('throws ConnectionError when accountName is missing for auto mode', async () => {
      await expect(resolveAuth({ type: 'auto' })).rejects.toThrow(ConnectionError);
      await expect(resolveAuth(undefined)).rejects.toThrow(ConnectionError);
    });

    it('uses dynamic import for @azure/identity', async () => {
      // This test verifies that DefaultAzureCredential was imported
      // (the mock proves the dynamic import path works)
      await resolveAuth({ type: 'auto' }, 'account');
      expect(MockDefaultAzureCredential).toHaveBeenCalledOnce();
    });
  });

  describe('connection-string mode', () => {
    it('creates client from connection string', async () => {
      const connStr =
        'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc;EndpointSuffix=core.windows.net';
      const result = await resolveAuth({ type: 'connection-string', connectionString: connStr });

      expect(result.client).toBeDefined();
      expect(MockBlobServiceClient.fromConnectionString).toHaveBeenCalledWith(connStr);
    });
  });

  describe('sas-token mode', () => {
    it('creates client with SAS token URL', async () => {
      const result = await resolveAuth({
        type: 'sas-token',
        accountName: 'myaccount',
        sasToken: 'sv=2024-01-01&ss=b&srt=o&sp=r',
      });

      expect(result.client).toBeDefined();
      expect(MockBlobServiceClient).toHaveBeenCalledWith(
        'https://myaccount.blob.core.windows.net?sv=2024-01-01&ss=b&srt=o&sp=r'
      );
    });

    it('strips leading ? from SAS token', async () => {
      await resolveAuth({
        type: 'sas-token',
        accountName: 'myaccount',
        sasToken: '?sv=2024-01-01&ss=b',
      });

      expect(MockBlobServiceClient).toHaveBeenCalledWith(
        'https://myaccount.blob.core.windows.net?sv=2024-01-01&ss=b'
      );
    });
  });

  describe('account-key mode', () => {
    it('creates client with StorageSharedKeyCredential', async () => {
      const result = await resolveAuth({
        type: 'account-key',
        accountName: 'myaccount',
        accountKey: 'base64key==',
      });

      expect(result.client).toBeDefined();
      expect(MockStorageSharedKeyCredential).toHaveBeenCalledWith('myaccount', 'base64key==');
      expect(MockBlobServiceClient).toHaveBeenCalledWith(
        'https://myaccount.blob.core.windows.net',
        expect.anything()
      );
    });
  });

  describe('exhaustive check', () => {
    it('throws for unknown auth type', async () => {
      const unknownAuth = { type: 'unknown-type' } as never;
      await expect(resolveAuth(unknownAuth)).rejects.toThrow('Unknown auth type');
    });
  });
});
