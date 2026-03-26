import { describe, it, expect } from 'vitest';
import { resolveAuth } from './auth.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

describe('resolveAuth', () => {
  it('returns scopes-only config for auto auth', () => {
    const result = resolveAuth({ type: 'auto' });
    expect(result).toEqual({ scopes: [SHEETS_SCOPE] });
  });

  it('returns scopes-only config when auth is undefined', () => {
    const result = resolveAuth(undefined);
    expect(result).toEqual({ scopes: [SHEETS_SCOPE] });
  });

  it('returns credentials for credentials auth', () => {
    const creds = {
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: 'key',
    };
    const result = resolveAuth({
      type: 'credentials',
      credentials: creds,
    });
    expect(result).toEqual({
      scopes: [SHEETS_SCOPE],
      credentials: creds,
    });
  });

  it('returns credentials when type is omitted', () => {
    const creds = {
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: 'key',
    };
    const result = resolveAuth({ credentials: creds });
    expect(result).toEqual({
      scopes: [SHEETS_SCOPE],
      credentials: creds,
    });
  });

  it('throws for unknown auth type', () => {
    const badAuth = { type: 'unknown' } as never;
    expect(() => resolveAuth(badAuth)).toThrow('Unknown auth type');
  });
});
