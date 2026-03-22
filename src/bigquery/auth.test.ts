import { describe, it, expect, vi } from 'vitest';
import { resolveAuth, resolveProjectId } from './auth.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

describe('resolveAuth', () => {
  it('returns empty options for auto auth', () => {
    const result = resolveAuth({ type: 'auto' });
    expect(result).toEqual({});
  });

  it('returns empty options when auth is undefined', () => {
    const result = resolveAuth(undefined);
    expect(result).toEqual({});
  });

  it('returns keyFilename for service-account auth', () => {
    const result = resolveAuth({
      type: 'service-account',
      keyFilePath: '/path/to/key.json',
    });
    expect(result).toEqual({ keyFilename: '/path/to/key.json' });
  });

  it('returns credentials for service-account-json auth', () => {
    const creds = { client_email: 'test@test.iam.gserviceaccount.com', private_key: 'key' };
    const result = resolveAuth({
      type: 'service-account-json',
      credentials: creds,
    });
    expect(result).toEqual({ credentials: creds });
  });
});

describe('resolveProjectId', () => {
  it('returns undefined when auth is undefined', () => {
    expect(resolveProjectId()).toBeUndefined();
  });

  it('returns undefined for auto auth', () => {
    expect(resolveProjectId({ type: 'auto' })).toBeUndefined();
  });

  it('reads project_id from service-account key file', async () => {
    const { readFileSync } = await import('node:fs');
    const mockReadFileSync = vi.mocked(readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'service_account',
        project_id: 'my-project-123',
        client_email: 'test@test.iam.gserviceaccount.com',
      })
    );

    const result = resolveProjectId({
      type: 'service-account',
      keyFilePath: '/path/to/key.json',
    });

    expect(result).toBe('my-project-123');
    expect(mockReadFileSync).toHaveBeenCalledWith('/path/to/key.json', 'utf-8');
  });

  it('returns undefined when key file has no project_id', async () => {
    const { readFileSync } = await import('node:fs');
    const mockReadFileSync = vi.mocked(readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'service_account',
        client_email: 'test@test.iam.gserviceaccount.com',
      })
    );

    const result = resolveProjectId({
      type: 'service-account',
      keyFilePath: '/path/to/key.json',
    });

    expect(result).toBeUndefined();
  });

  it('extracts project_id from service-account-json credentials', () => {
    const result = resolveProjectId({
      type: 'service-account-json',
      credentials: { project_id: 'json-project' },
    });

    expect(result).toBe('json-project');
  });

  it('returns undefined when credentials have no project_id', () => {
    const result = resolveProjectId({
      type: 'service-account-json',
      credentials: { client_email: 'test@test.iam.gserviceaccount.com' },
    });

    expect(result).toBeUndefined();
  });
});
