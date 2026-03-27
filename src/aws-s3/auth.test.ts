import { describe, it, expect } from 'vitest';
import { resolveAuth } from './auth.js';

describe('resolveAuth', () => {
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

  it('returns credentials when type is omitted', () => {
    const result = resolveAuth({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secrettest',
      region: 'ap-northeast-1',
    });

    expect(result).toEqual({
      credentials: {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secrettest',
      },
      region: 'ap-northeast-1',
    });
  });
});
