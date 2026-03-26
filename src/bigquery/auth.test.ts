import { describe, it, expect } from 'vitest';
import { resolveAuth, resolveProjectId } from './auth.js';

describe('resolveAuth', () => {
  it('returns credentials for credentials auth', () => {
    const creds = { client_email: 'test@test.iam.gserviceaccount.com', private_key: 'key' };
    const result = resolveAuth({
      type: 'credentials',
      credentials: creds,
    });
    expect(result).toEqual({ credentials: creds });
  });

  it('returns credentials when type is omitted', () => {
    const creds = { client_email: 'test@test.iam.gserviceaccount.com', private_key: 'key' };
    const result = resolveAuth({
      credentials: creds,
    });
    expect(result).toEqual({ credentials: creds });
  });

  it('throws for unknown auth type (runtime guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badAuth = { type: 'unknown-type', credentials: {} } as any;
    expect(() => resolveAuth(badAuth)).toThrow(/Unknown auth type/);
  });
});

describe('resolveProjectId', () => {
  it('extracts project_id from credentials auth', () => {
    const result = resolveProjectId({
      type: 'credentials',
      credentials: { project_id: 'json-project' },
    });

    expect(result).toBe('json-project');
  });

  it('extracts project_id when type is omitted', () => {
    const result = resolveProjectId({
      credentials: { project_id: 'json-project' },
    });

    expect(result).toBe('json-project');
  });

  it('returns undefined when credentials have no project_id', () => {
    const result = resolveProjectId({
      type: 'credentials',
      credentials: { client_email: 'test@test.iam.gserviceaccount.com' },
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when project_id is empty string', () => {
    const result = resolveProjectId({
      type: 'credentials',
      credentials: { project_id: '' },
    });

    expect(result).toBeUndefined();
  });

  it('throws for unknown auth type (runtime guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badAuth = { type: 'unknown-type', credentials: {} } as any;
    expect(() => resolveProjectId(badAuth)).toThrow(/Unknown auth type/);
  });
});
