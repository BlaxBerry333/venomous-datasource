import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthenticationError } from '../core/index.js';

// Mock @azure/storage-blob
const MockBlobServiceClient = vi.fn();
MockBlobServiceClient.fromConnectionString = vi.fn(() => ({ mock: 'from-conn-string' }));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: MockBlobServiceClient,
}));

// Import after mocks
const { resolveAuth } = await import('./auth.js');

describe('resolveAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockBlobServiceClient.mockImplementation(() => ({ mock: 'client' }));
  });

  describe('undefined auth', () => {
    it('throws AuthenticationError when auth is undefined', async () => {
      await expect(resolveAuth(undefined)).rejects.toThrow(AuthenticationError);
    });

    it('includes VENOMOUS_AUTH_REQUIRED code', async () => {
      try {
        await resolveAuth(undefined);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as AuthenticationError).code).toBe('VENOMOUS_AUTH_REQUIRED');
      }
    });

    it('includes available auth modes in error message', async () => {
      try {
        await resolveAuth(undefined);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as AuthenticationError).message).toContain('connection-string');
        expect((err as AuthenticationError).message).toContain('sas-token');
      }
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

  describe('exhaustive check', () => {
    it('throws for unknown auth type', async () => {
      const unknownAuth = { type: 'unknown-type' } as never;
      await expect(resolveAuth(unknownAuth)).rejects.toThrow('Unknown auth type');
    });
  });
});
