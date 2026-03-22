import { describe, it, expect, vi } from 'vitest';
import { resolveAuth } from './auth.js';

// Mock @aws-sdk/credential-providers
vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: vi.fn(({ profile }: { profile: string }) => ({
    _type: 'fromIni',
    profile,
  })),
}));

describe('resolveAuth', () => {
  it('returns empty config for auto auth', () => {
    const result = resolveAuth({ type: 'auto' });
    expect(result).toEqual({});
  });

  it('returns empty config when auth is undefined', () => {
    const result = resolveAuth(undefined);
    expect(result).toEqual({});
  });

  it('applies defaultRegion for auto auth', () => {
    const result = resolveAuth({ type: 'auto' }, 'us-west-2');
    expect(result).toEqual({ region: 'us-west-2' });
  });

  it('applies defaultRegion when auth is undefined', () => {
    const result = resolveAuth(undefined, 'ap-northeast-1');
    expect(result).toEqual({ region: 'ap-northeast-1' });
  });

  it('returns credentials and region for access-key auth', () => {
    const result = resolveAuth({
      type: 'access-key',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secrettest',
      region: 'us-east-1',
    });

    expect(result).toEqual({
      credentials: {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secrettest',
      },
      region: 'us-east-1',
    });
  });

  it('returns fromIni credentials for profile auth', () => {
    const result = resolveAuth({
      type: 'profile',
      profileName: 'my-profile',
      region: 'eu-west-1',
    });

    expect(result).toEqual({
      credentials: { _type: 'fromIni', profile: 'my-profile' },
      region: 'eu-west-1',
    });
  });

  it('uses defaultRegion when profile auth has no region', () => {
    const result = resolveAuth({ type: 'profile', profileName: 'dev' }, 'ap-southeast-1');

    expect(result.region).toBe('ap-southeast-1');
  });

  it('prefers profile region over defaultRegion', () => {
    const result = resolveAuth(
      { type: 'profile', profileName: 'dev', region: 'us-west-1' },
      'ap-southeast-1'
    );

    expect(result.region).toBe('us-west-1');
  });
});
