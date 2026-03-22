import { describe, it, expect } from 'vitest';
import { toS3Key, fromS3Key, toS3Prefix } from './path.js';
import { PathError } from '../core/index.js';

describe('toS3Key', () => {
  describe('basic paths', () => {
    it('converts simple ASCII path', () => {
      expect(toS3Key('data/file.csv')).toBe('data/file.csv');
    });

    it('prepends prefix', () => {
      expect(toS3Key('file.csv', 'uploads')).toBe('uploads/file.csv');
    });

    it('prepends prefix with nested path', () => {
      expect(toS3Key('reports/2024/sales.csv', 'data')).toBe('data/reports/2024/sales.csv');
    });

    it('strips leading/trailing slashes from prefix', () => {
      expect(toS3Key('file.csv', '/uploads/')).toBe('uploads/file.csv');
    });

    it('returns prefix with trailing slash for empty path', () => {
      expect(toS3Key(undefined, 'data')).toBe('data/');
    });

    it('returns empty string for empty path without prefix', () => {
      expect(toS3Key(undefined)).toBe('');
    });

    it('returns empty string for whitespace path without prefix', () => {
      expect(toS3Key('  ')).toBe('');
    });
  });

  describe('CJK characters', () => {
    it('encodes Japanese characters', () => {
      const result = toS3Key('reports/月次レポート.csv');
      expect(result).toContain('reports/');
      expect(result).toContain('.csv');
      // CJK chars should be percent-encoded
      expect(result).not.toContain('月');
      expect(result).not.toContain('次');
    });

    it('encodes Chinese characters', () => {
      const result = toS3Key('data/数据文件.json');
      expect(result).toContain('data/');
      expect(result).toContain('.json');
      expect(result).not.toContain('数');
    });

    it('encodes mixed CJK and ASCII', () => {
      const result = toS3Key('reports/2024年度_summary.csv');
      expect(result).toContain('reports/');
      expect(result).toContain('_summary.csv');
      expect(result).not.toContain('年');
    });

    it('preserves ASCII characters', () => {
      expect(toS3Key('data/file-name_v2.csv')).toBe('data/file-name_v2.csv');
    });

    it('encodes with prefix', () => {
      const result = toS3Key('日本語テスト.csv', 'data');
      expect(result).toContain('data/');
      expect(result).toContain('.csv');
      expect(result).not.toContain('日');
    });
  });

  describe('security', () => {
    it('rejects path traversal', () => {
      expect(() => toS3Key('../etc/passwd')).toThrow(PathError);
    });

    it('rejects absolute path', () => {
      expect(() => toS3Key('/etc/passwd')).toThrow(PathError);
    });

    it('rejects encoded traversal', () => {
      expect(() => toS3Key('..%2Fetc%2Fpasswd')).toThrow(PathError);
    });
  });
});

describe('fromS3Key', () => {
  it('returns path without prefix', () => {
    expect(fromS3Key('data/file.csv')).toBe('data/file.csv');
  });

  it('strips prefix', () => {
    expect(fromS3Key('uploads/data/file.csv', 'uploads')).toBe('data/file.csv');
  });

  it('strips trailing slash from directory key', () => {
    expect(fromS3Key('data/reports/', 'data')).toBe('reports');
  });

  it('decodes CJK characters', () => {
    const encoded = 'data/%E6%97%A5%E6%9C%AC%E8%AA%9E.csv';
    expect(fromS3Key(encoded, 'data')).toBe('日本語.csv');
  });

  it('handles already-decoded keys', () => {
    expect(fromS3Key('data/日本語.csv', 'data')).toBe('日本語.csv');
  });

  it('handles key that is just the prefix', () => {
    expect(fromS3Key('data/', 'data')).toBe('');
  });

  it('handles malformed percent encoding gracefully', () => {
    // Keys with invalid percent encoding should be returned as-is
    expect(fromS3Key('data/file%ZZ.csv', 'data')).toBe('file%ZZ.csv');
  });
});

describe('toS3Prefix', () => {
  it('adds trailing slash to path', () => {
    expect(toS3Prefix('reports', 'data')).toBe('data/reports/');
  });

  it('returns prefix with trailing slash for empty path', () => {
    expect(toS3Prefix(undefined, 'data')).toBe('data/');
  });

  it('returns empty string for no path and no prefix', () => {
    expect(toS3Prefix(undefined)).toBe('');
  });

  it('does not double trailing slash', () => {
    // toS3Key for a path always ends without /, toS3Prefix adds /
    expect(toS3Prefix('reports', 'data')).toBe('data/reports/');
  });
});

describe('roundtrip', () => {
  it('ASCII path roundtrips', () => {
    const original = 'reports/2024/summary.csv';
    const key = toS3Key(original, 'data');
    const back = fromS3Key(key, 'data');
    expect(back).toBe(original);
  });

  it('CJK path roundtrips', () => {
    const original = 'reports/月次レポート.csv';
    const key = toS3Key(original, 'data');
    const back = fromS3Key(key, 'data');
    expect(back).toBe(original);
  });

  it('Chinese path roundtrips', () => {
    const original = 'data/数据文件 (1).json';
    const key = toS3Key(original);
    const back = fromS3Key(key);
    expect(back).toBe(original);
  });

  it('path with spaces roundtrips', () => {
    const original = 'dir/file with spaces.txt';
    const key = toS3Key(original, 'prefix');
    const back = fromS3Key(key, 'prefix');
    expect(back).toBe(original);
  });
});
