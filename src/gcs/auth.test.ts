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

  it('returns credentials for credentials auth', () => {
    const creds = {
      type: 'service_account',
      project_id: 'test-project',
      private_key: 'pk',
      client_email: 'test@test.iam.gserviceaccount.com',
    };

    const result = resolveAuth({
      type: 'credentials',
      credentials: creds,
    });

    expect(result).toEqual({
      credentials: creds,
    });
  });

  it('returns credentials when type is omitted', () => {
    const creds = {
      type: 'service_account',
      project_id: 'test-project',
      private_key: 'pk',
      client_email: 'test@test.iam.gserviceaccount.com',
    };

    const result = resolveAuth({ credentials: creds });

    expect(result).toEqual({
      credentials: creds,
    });
  });

  it('includes projectId with credentials auth', () => {
    const creds = { type: 'service_account', project_id: 'test-project' };

    const result = resolveAuth(
      {
        type: 'credentials',
        credentials: creds,
      },
      'override-project'
    );

    expect(result.projectId).toBe('override-project');
    expect(result.credentials).toBe(creds);
  });

  it('throws for unknown auth type', () => {
    const badAuth = { type: 'unknown' } as never;
    expect(() => resolveAuth(badAuth)).toThrow('Unknown auth type');
  });
});
