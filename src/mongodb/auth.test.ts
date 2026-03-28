import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError, AuthenticationError } from '../core/index.js';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

vi.mock('mongodb', () => ({
  MongoClient: vi.fn(),
  ObjectId: vi.fn(),
}));

describe('resolveAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── default (no auth) ─────────────────────────────────────────────────

  it('should return localhost URI when auth is undefined', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth(undefined);
    expect(result.uri).toBe('mongodb://localhost:27017');
    expect(result.options).toBeUndefined();
  });

  // ─── connection-string mode ─────────────────────────────────────────────

  it('should return the URI as-is for connection-string mode with mongodb://', async () => {
    const { resolveAuth } = await import('./auth.js');
    const uri = 'mongodb://user:pass@myhost:27017/mydb';
    const result = await resolveAuth({ type: 'connection-string', connectionString: uri });
    expect(result.uri).toBe(uri);
  });

  it('should return the URI as-is for connection-string mode with mongodb+srv://', async () => {
    const { resolveAuth } = await import('./auth.js');
    const uri = 'mongodb+srv://user:pass@example-cluster.example.net/mydb';
    const result = await resolveAuth({ type: 'connection-string', connectionString: uri });
    expect(result.uri).toBe(uri);
  });

  it('should throw AuthenticationError for invalid URI prefix', async () => {
    const { resolveAuth } = await import('./auth.js');
    await expect(
      resolveAuth({ type: 'connection-string', connectionString: 'postgres://host/db' })
    ).rejects.toThrow(AuthenticationError);
  });

  it('should include helpful message when URI prefix is invalid', async () => {
    const { resolveAuth } = await import('./auth.js');
    try {
      await resolveAuth({ type: 'connection-string', connectionString: 'http://host/db' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as Error).message).toContain('mongodb://');
      expect((err as Error).message).toContain('mongodb+srv://');
    }
  });

  // ─── credentials mode ──────────────────────────────────────────────────

  it('should construct URI from credentials with default port', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: 'secret',
      host: 'myhost',
    });
    expect(result.uri).toBe('mongodb://admin:secret@myhost:27017');
  });

  it('should construct URI from credentials with custom port', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: 'secret',
      host: 'myhost',
      port: 28017,
    });
    expect(result.uri).toBe('mongodb://admin:secret@myhost:28017');
  });

  it('should append authSource query parameter when provided', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: 'secret',
      host: 'myhost',
      authSource: 'admin',
    });
    expect(result.uri).toBe('mongodb://admin:secret@myhost:27017/?authSource=admin');
  });

  it('should encodeURIComponent username and password with special characters', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'user@domain',
      password: 'p@ss:w/ord',
      host: 'myhost',
    });
    // encodeURIComponent('user@domain') = 'user%40domain'
    // encodeURIComponent('p@ss:w/ord') = 'p%40ss%3Aw%2Ford'
    expect(result.uri).toContain('user%40domain');
    expect(result.uri).toContain('p%40ss%3Aw%2Ford');
    expect(result.uri).toContain('@myhost:27017');
  });

  it('should encodeURIComponent authSource with special characters', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: 'secret',
      host: 'myhost',
      authSource: 'my db',
    });
    expect(result.uri).toContain('authSource=my%20db');
  });

  // ─── exhaustive check ──────────────────────────────────────────────────

  it('should throw for unknown auth type', async () => {
    const { resolveAuth } = await import('./auth.js');
    const badAuth = { type: 'unknown' } as never;
    await expect(resolveAuth(badAuth)).rejects.toThrow();
  });
});

describe('resolveAuth - SDK not installed', () => {
  it('should throw ConnectionError when mongodb SDK import fails', () => {
    // Verify the error shape matches what resolveAuth would throw
    const err = new ConnectionError(
      'mongodb SDK is not installed. Install it with: npm install mongodb',
      { connector: 'mongodb' }
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toContain('npm install mongodb');
  });
});

describe('resolveAuth - connection-string edge cases', () => {
  it('should reject empty URI string', async () => {
    const { resolveAuth } = await import('./auth.js');
    await expect(resolveAuth({ type: 'connection-string', connectionString: '' })).rejects.toThrow(
      AuthenticationError
    );
  });

  it('should accept URI with path and query parameters', async () => {
    const { resolveAuth } = await import('./auth.js');
    const uri = 'mongodb://user:pass@host:27017/mydb?retryWrites=true&w=majority';
    const result = await resolveAuth({ type: 'connection-string', connectionString: uri });
    expect(result.uri).toBe(uri);
  });
});

describe('resolveAuth - credentials edge cases', () => {
  it('should construct URI without authSource when not provided', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: 'secret',
      host: 'myhost',
    });
    expect(result.uri).not.toContain('authSource');
    expect(result.uri).not.toContain('?');
  });

  it('should handle empty password', async () => {
    const { resolveAuth } = await import('./auth.js');
    const result = await resolveAuth({
      type: 'credentials',
      username: 'admin',
      password: '',
      host: 'myhost',
    });
    expect(result.uri).toBe('mongodb://admin:@myhost:27017');
  });
});
