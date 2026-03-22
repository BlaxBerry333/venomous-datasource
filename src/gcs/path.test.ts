import { describe, it, expect } from 'vitest';
import { toGCSPath, fromGCSPath, toGCSPrefix } from './path.js';
import { PathError } from '../core/index.js';

describe('toGCSPath', () => {
  describe('basic paths', () => {
    it('converts simple ASCII path', () => {
      expect(toGCSPath('data/file.csv')).toBe('data/file.csv');
    });

    it('prepends prefix', () => {
      expect(toGCSPath('file.csv', 'uploads')).toBe('uploads/file.csv');
    });

    it('prepends prefix with nested path', () => {
      expect(toGCSPath('reports/2024/sales.csv', 'data')).toBe('data/reports/2024/sales.csv');
    });

    it('strips leading/trailing slashes from prefix', () => {
      expect(toGCSPath('file.csv', '/uploads/')).toBe('uploads/file.csv');
    });

    it('returns prefix with trailing slash for empty path', () => {
      expect(toGCSPath(undefined, 'data')).toBe('data/');
    });

    it('returns empty string for empty path without prefix', () => {
      expect(toGCSPath(undefined)).toBe('');
    });

    it('returns empty string for whitespace path without prefix', () => {
      expect(toGCSPath('  ')).toBe('');
    });
  });

  describe('CJK characters (NOT encoded, unlike S3)', () => {
    it('preserves Japanese characters as-is', () => {
      const result = toGCSPath('reports/月次レポート.csv');
      expect(result).toBe('reports/月次レポート.csv');
      // GCS does NOT percent-encode CJK chars
      expect(result).toContain('月');
      expect(result).toContain('次');
    });

    it('preserves Chinese characters as-is', () => {
      const result = toGCSPath('data/数据文件.json');
      expect(result).toBe('data/数据文件.json');
      expect(result).toContain('数');
    });

    it('preserves mixed CJK and ASCII', () => {
      const result = toGCSPath('reports/2024年度_summary.csv');
      expect(result).toBe('reports/2024年度_summary.csv');
    });

    it('preserves ASCII characters', () => {
      expect(toGCSPath('data/file-name_v2.csv')).toBe('data/file-name_v2.csv');
    });

    it('preserves CJK with prefix', () => {
      const result = toGCSPath('日本語テスト.csv', 'data');
      expect(result).toBe('data/日本語テスト.csv');
    });
  });

  describe('NFC normalization', () => {
    it('normalizes NFD to NFC', () => {
      // e\u0301 (NFD: e + combining acute) -> \u00e9 (NFC: e with acute)
      const nfd = 'data/re\u0301sume\u0301.csv';
      const result = toGCSPath(nfd);
      expect(result).toBe('data/r\u00e9sum\u00e9.csv');
    });

    it('normalizes Japanese NFD to NFC', () => {
      // NFD decomposed form of テスト
      const nfd = 'data/\u30C6\u30B9\u30C8.csv';
      const result = toGCSPath(nfd);
      // Should be NFC normalized (same chars for katakana, but the function runs NFC)
      expect(result).toBe('data/テスト.csv');
    });
  });

  describe('security', () => {
    it('rejects path traversal', () => {
      expect(() => toGCSPath('../etc/passwd')).toThrow(PathError);
    });

    it('rejects absolute path', () => {
      expect(() => toGCSPath('/etc/passwd')).toThrow(PathError);
    });

    it('rejects encoded traversal', () => {
      expect(() => toGCSPath('..%2Fetc%2Fpasswd')).toThrow(PathError);
    });
  });
});

describe('fromGCSPath', () => {
  it('returns path without prefix', () => {
    expect(fromGCSPath('data/file.csv')).toBe('data/file.csv');
  });

  it('strips prefix', () => {
    expect(fromGCSPath('uploads/data/file.csv', 'uploads')).toBe('data/file.csv');
  });

  it('strips trailing slash from directory path', () => {
    expect(fromGCSPath('data/reports/', 'data')).toBe('reports');
  });

  it('preserves CJK characters (no decoding needed)', () => {
    expect(fromGCSPath('data/日本語.csv', 'data')).toBe('日本語.csv');
  });

  it('handles path that is just the prefix', () => {
    expect(fromGCSPath('data/', 'data')).toBe('');
  });

  it('NFC normalizes returned path', () => {
    // If GCS returns NFD path (e.g., from macOS upload), fromGCSPath normalizes to NFC
    const nfdPath = 'data/re\u0301sume\u0301.csv';
    expect(fromGCSPath(nfdPath, 'data')).toBe('r\u00e9sum\u00e9.csv');
  });
});

describe('toGCSPrefix', () => {
  it('adds trailing slash to path', () => {
    expect(toGCSPrefix('reports', 'data')).toBe('data/reports/');
  });

  it('returns prefix with trailing slash for empty path', () => {
    expect(toGCSPrefix(undefined, 'data')).toBe('data/');
  });

  it('returns empty string for no path and no prefix', () => {
    expect(toGCSPrefix(undefined)).toBe('');
  });

  it('does not double trailing slash', () => {
    expect(toGCSPrefix('reports', 'data')).toBe('data/reports/');
  });
});

describe('roundtrip', () => {
  it('ASCII path roundtrips', () => {
    const original = 'reports/2024/summary.csv';
    const gcsPath = toGCSPath(original, 'data');
    const back = fromGCSPath(gcsPath, 'data');
    expect(back).toBe(original);
  });

  it('CJK path roundtrips (no encoding/decoding needed)', () => {
    const original = 'reports/月次レポート.csv';
    const gcsPath = toGCSPath(original, 'data');
    const back = fromGCSPath(gcsPath, 'data');
    expect(back).toBe(original);
  });

  it('Chinese path roundtrips', () => {
    const original = 'data/数据文件 (1).json';
    const gcsPath = toGCSPath(original);
    const back = fromGCSPath(gcsPath);
    expect(back).toBe(original);
  });

  it('path with spaces roundtrips', () => {
    const original = 'dir/file with spaces.txt';
    const gcsPath = toGCSPath(original, 'prefix');
    const back = fromGCSPath(gcsPath, 'prefix');
    expect(back).toBe(original);
  });
});
