import { describe, it, expect } from 'vitest';
import { resolveAuth } from './auth.js';

describe('resolveAuth', () => {
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

  it('includes projectId with credentials auth when type is omitted', () => {
    const creds = { type: 'service_account', project_id: 'test-project' };

    const result = resolveAuth({ credentials: creds }, 'override-project');

    expect(result.projectId).toBe('override-project');
    expect(result.credentials).toBe(creds);
  });
});
