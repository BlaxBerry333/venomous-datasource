import { describe, it, expect } from 'vitest';
import { resolveAuth } from './auth.js';

describe('resolveAuth', () => {
  it('returns empty config for auto auth', () => {
    const result = resolveAuth({ type: 'auto' });
    expect(result).toEqual({});
  });

  it('returns empty config when auth is undefined', () => {
    const result = resolveAuth(undefined);
    expect(result).toEqual({});
  });

  it('applies projectId for auto auth', () => {
    const result = resolveAuth({ type: 'auto' }, 'my-project');
    expect(result).toEqual({ projectId: 'my-project' });
  });

  it('applies projectId when auth is undefined', () => {
    const result = resolveAuth(undefined, 'my-project');
    expect(result).toEqual({ projectId: 'my-project' });
  });

  it('returns keyFilename for service-account auth', () => {
    const result = resolveAuth({
      type: 'service-account',
      keyFilePath: '/path/to/key.json',
    });

    expect(result).toEqual({
      keyFilename: '/path/to/key.json',
    });
  });

  it('includes projectId with service-account auth', () => {
    const result = resolveAuth(
      {
        type: 'service-account',
        keyFilePath: '/path/to/key.json',
      },
      'my-project'
    );

    expect(result).toEqual({
      projectId: 'my-project',
      keyFilename: '/path/to/key.json',
    });
  });

  it('returns credentials for service-account-json auth', () => {
    const creds = {
      type: 'service_account',
      project_id: 'test-project',
      private_key: 'pk',
      client_email: 'test@test.iam.gserviceaccount.com',
    };

    const result = resolveAuth({
      type: 'service-account-json',
      credentials: creds,
    });

    expect(result).toEqual({
      credentials: creds,
    });
  });

  it('includes projectId with service-account-json auth', () => {
    const creds = { type: 'service_account', project_id: 'test-project' };

    const result = resolveAuth(
      {
        type: 'service-account-json',
        credentials: creds,
      },
      'override-project'
    );

    expect(result.projectId).toBe('override-project');
    expect(result.credentials).toBe(creds);
  });
});
