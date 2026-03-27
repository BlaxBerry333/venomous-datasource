import { describe, it, expect } from 'vitest';
import { toBlobPath, fromBlobPath, toBlobPrefix } from './path.js';
import { PathError } from '../core/index.js';

describe('toBlobPath', () => {
  describe('basic paths', () => {
    it('converts simple ASCII path', () => {
      expect(toBlobPath('data/file.csv')).toBe('data/file.csv');
    });

    it('prepends prefix', () => {
      expect(toBlobPath('file.csv', 'uploads')).toBe('uploads/file.csv');
    });

    it('prepends prefix with nested path', () => {
      expect(toBlobPath('reports/2024/sales.csv', 'data')).toBe('data/reports/2024/sales.csv');
    });

    it('strips leading/trailing slashes from prefix', () => {
      expect(toBlobPath('file.csv', '/uploads/')).toBe('uploads/file.csv');
    });

    it('returns prefix with trailing slash for empty path', () => {
      expect(toBlobPath(undefined, 'data')).toBe('data/');
    });

    it('returns empty string for empty path without prefix', () => {
      expect(toBlobPath(undefined)).toBe('');
    });

    it('returns empty string for whitespace path without prefix', () => {
      expect(toBlobPath('  ')).toBe('');
    });
  });

  describe('CJK characters (NOT encoded, like Google Cloud Storage)', () => {
    it('preserves Japanese characters as-is', () => {
      const result = toBlobPath('reports/月次レポート.csv');
      expect(result).toBe('reports/月次レポート.csv');
      expect(result).toContain('月');
      expect(result).toContain('次');
    });

    it('preserves Chinese characters as-is', () => {
      const result = toBlobPath('data/数据文件.json');
      expect(result).toBe('data/数据文件.json');
      expect(result).toContain('数');
    });

    it('preserves mixed CJK and ASCII', () => {
      const result = toBlobPath('reports/2024年度_summary.csv');
      expect(result).toBe('reports/2024年度_summary.csv');
    });

    it('preserves ASCII characters', () => {
      expect(toBlobPath('data/file-name_v2.csv')).toBe('data/file-name_v2.csv');
    });

    it('preserves CJK with prefix', () => {
      const result = toBlobPath('日本語テスト.csv', 'data');
      expect(result).toBe('data/日本語テスト.csv');
    });
  });

  describe('NFC normalization', () => {
    it('normalizes NFD to NFC', () => {
      const nfd = 'data/re\u0301sume\u0301.csv';
      const result = toBlobPath(nfd);
      expect(result).toBe('data/r\u00e9sum\u00e9.csv');
    });

    it('normalizes Japanese NFD to NFC', () => {
      const nfd = 'data/\u30C6\u30B9\u30C8.csv';
      const result = toBlobPath(nfd);
      expect(result).toBe('data/テスト.csv');
    });
  });

  describe('security', () => {
    it('rejects path traversal', () => {
      expect(() => toBlobPath('../etc/passwd')).toThrow(PathError);
    });

    it('rejects absolute path', () => {
      expect(() => toBlobPath('/etc/passwd')).toThrow(PathError);
    });

    it('rejects encoded traversal', () => {
      expect(() => toBlobPath('..%2Fetc%2Fpasswd')).toThrow(PathError);
    });
  });
});

describe('fromBlobPath', () => {
  it('returns path without prefix', () => {
    expect(fromBlobPath('data/file.csv')).toBe('data/file.csv');
  });

  it('strips prefix', () => {
    expect(fromBlobPath('uploads/data/file.csv', 'uploads')).toBe('data/file.csv');
  });

  it('strips trailing slash from directory path', () => {
    expect(fromBlobPath('data/reports/', 'data')).toBe('reports');
  });

  it('preserves CJK characters (no decoding needed)', () => {
    expect(fromBlobPath('data/日本語.csv', 'data')).toBe('日本語.csv');
  });

  it('handles path that is just the prefix', () => {
    expect(fromBlobPath('data/', 'data')).toBe('');
  });

  it('handles path that equals prefix without trailing slash', () => {
    expect(fromBlobPath('data', 'data')).toBe('');
  });

  it('NFC normalizes returned path', () => {
    const nfdPath = 'data/re\u0301sume\u0301.csv';
    expect(fromBlobPath(nfdPath, 'data')).toBe('r\u00e9sum\u00e9.csv');
  });
});

describe('toBlobPrefix', () => {
  it('adds trailing slash to path', () => {
    expect(toBlobPrefix('reports', 'data')).toBe('data/reports/');
  });

  it('returns prefix with trailing slash for empty path', () => {
    expect(toBlobPrefix(undefined, 'data')).toBe('data/');
  });

  it('returns empty string for no path and no prefix', () => {
    expect(toBlobPrefix(undefined)).toBe('');
  });

  it('does not double trailing slash', () => {
    expect(toBlobPrefix('reports', 'data')).toBe('data/reports/');
  });
});

describe('roundtrip', () => {
  it('ASCII path roundtrips', () => {
    const original = 'reports/2024/summary.csv';
    const blobPath = toBlobPath(original, 'data');
    const back = fromBlobPath(blobPath, 'data');
    expect(back).toBe(original);
  });

  it('CJK path roundtrips', () => {
    const original = 'reports/月次レポート.csv';
    const blobPath = toBlobPath(original, 'data');
    const back = fromBlobPath(blobPath, 'data');
    expect(back).toBe(original);
  });

  it('Chinese path roundtrips', () => {
    const original = 'data/数据文件 (1).json';
    const blobPath = toBlobPath(original);
    const back = fromBlobPath(blobPath);
    expect(back).toBe(original);
  });

  it('path with spaces roundtrips', () => {
    const original = 'dir/file with spaces.txt';
    const blobPath = toBlobPath(original, 'prefix');
    const back = fromBlobPath(blobPath, 'prefix');
    expect(back).toBe(original);
  });
});
