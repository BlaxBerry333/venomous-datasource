import { describe, it, expect } from 'vitest';
import {
  toGoogleCloudStoragePath,
  fromGoogleCloudStoragePath,
  toGoogleCloudStoragePrefix,
} from './path.js';
import { PathError } from '../core/index.js';

describe('toGoogleCloudStoragePath', () => {
  describe('basic paths', () => {
    it('converts simple ASCII path', () => {
      expect(toGoogleCloudStoragePath('data/file.csv')).toBe('data/file.csv');
    });

    it('prepends prefix', () => {
      expect(toGoogleCloudStoragePath('file.csv', 'uploads')).toBe('uploads/file.csv');
    });

    it('prepends prefix with nested path', () => {
      expect(toGoogleCloudStoragePath('reports/2024/sales.csv', 'data')).toBe(
        'data/reports/2024/sales.csv'
      );
    });

    it('strips leading/trailing slashes from prefix', () => {
      expect(toGoogleCloudStoragePath('file.csv', '/uploads/')).toBe('uploads/file.csv');
    });

    it('returns prefix with trailing slash for empty path', () => {
      expect(toGoogleCloudStoragePath(undefined, 'data')).toBe('data/');
    });

    it('returns empty string for empty path without prefix', () => {
      expect(toGoogleCloudStoragePath(undefined)).toBe('');
    });

    it('returns empty string for whitespace path without prefix', () => {
      expect(toGoogleCloudStoragePath('  ')).toBe('');
    });
  });

  describe('CJK characters (NOT encoded, unlike S3)', () => {
    it('preserves Japanese characters as-is', () => {
      const result = toGoogleCloudStoragePath('reports/月次レポート.csv');
      expect(result).toBe('reports/月次レポート.csv');
      // Google Cloud Storage does NOT percent-encode CJK chars
      expect(result).toContain('月');
      expect(result).toContain('次');
    });

    it('preserves Chinese characters as-is', () => {
      const result = toGoogleCloudStoragePath('data/数据文件.json');
      expect(result).toBe('data/数据文件.json');
      expect(result).toContain('数');
    });

    it('preserves mixed CJK and ASCII', () => {
      const result = toGoogleCloudStoragePath('reports/2024年度_summary.csv');
      expect(result).toBe('reports/2024年度_summary.csv');
    });

    it('preserves ASCII characters', () => {
      expect(toGoogleCloudStoragePath('data/file-name_v2.csv')).toBe('data/file-name_v2.csv');
    });

    it('preserves CJK with prefix', () => {
      const result = toGoogleCloudStoragePath('日本語テスト.csv', 'data');
      expect(result).toBe('data/日本語テスト.csv');
    });
  });

  describe('NFC normalization', () => {
    it('normalizes NFD to NFC', () => {
      // e\u0301 (NFD: e + combining acute) -> \u00e9 (NFC: e with acute)
      const nfd = 'data/re\u0301sume\u0301.csv';
      const result = toGoogleCloudStoragePath(nfd);
      expect(result).toBe('data/r\u00e9sum\u00e9.csv');
    });

    it('normalizes Japanese NFD to NFC', () => {
      // NFD decomposed form of テスト
      const nfd = 'data/\u30C6\u30B9\u30C8.csv';
      const result = toGoogleCloudStoragePath(nfd);
      // Should be NFC normalized (same chars for katakana, but the function runs NFC)
      expect(result).toBe('data/テスト.csv');
    });
  });

  describe('security', () => {
    it('rejects path traversal', () => {
      expect(() => toGoogleCloudStoragePath('../etc/passwd')).toThrow(PathError);
    });

    it('rejects absolute path', () => {
      expect(() => toGoogleCloudStoragePath('/etc/passwd')).toThrow(PathError);
    });

    it('rejects encoded traversal', () => {
      expect(() => toGoogleCloudStoragePath('..%2Fetc%2Fpasswd')).toThrow(PathError);
    });
  });
});

describe('fromGoogleCloudStoragePath', () => {
  it('returns path without prefix', () => {
    expect(fromGoogleCloudStoragePath('data/file.csv')).toBe('data/file.csv');
  });

  it('strips prefix', () => {
    expect(fromGoogleCloudStoragePath('uploads/data/file.csv', 'uploads')).toBe('data/file.csv');
  });

  it('strips trailing slash from directory path', () => {
    expect(fromGoogleCloudStoragePath('data/reports/', 'data')).toBe('reports');
  });

  it('preserves CJK characters (no decoding needed)', () => {
    expect(fromGoogleCloudStoragePath('data/日本語.csv', 'data')).toBe('日本語.csv');
  });

  it('handles path that is just the prefix', () => {
    expect(fromGoogleCloudStoragePath('data/', 'data')).toBe('');
  });

  it('NFC normalizes returned path', () => {
    // If Google Cloud Storage returns NFD path (e.g., from macOS upload), fromGoogleCloudStoragePath normalizes to NFC
    const nfdPath = 'data/re\u0301sume\u0301.csv';
    expect(fromGoogleCloudStoragePath(nfdPath, 'data')).toBe('r\u00e9sum\u00e9.csv');
  });
});

describe('toGoogleCloudStoragePrefix', () => {
  it('adds trailing slash to path', () => {
    expect(toGoogleCloudStoragePrefix('reports', 'data')).toBe('data/reports/');
  });

  it('returns prefix with trailing slash for empty path', () => {
    expect(toGoogleCloudStoragePrefix(undefined, 'data')).toBe('data/');
  });

  it('returns empty string for no path and no prefix', () => {
    expect(toGoogleCloudStoragePrefix(undefined)).toBe('');
  });

  it('does not double trailing slash', () => {
    expect(toGoogleCloudStoragePrefix('reports', 'data')).toBe('data/reports/');
  });
});

describe('roundtrip', () => {
  it('ASCII path roundtrips', () => {
    const original = 'reports/2024/summary.csv';
    const googleCloudStoragePath = toGoogleCloudStoragePath(original, 'data');
    const back = fromGoogleCloudStoragePath(googleCloudStoragePath, 'data');
    expect(back).toBe(original);
  });

  it('CJK path roundtrips (no encoding/decoding needed)', () => {
    const original = 'reports/月次レポート.csv';
    const googleCloudStoragePath = toGoogleCloudStoragePath(original, 'data');
    const back = fromGoogleCloudStoragePath(googleCloudStoragePath, 'data');
    expect(back).toBe(original);
  });

  it('Chinese path roundtrips', () => {
    const original = 'data/数据文件 (1).json';
    const googleCloudStoragePath = toGoogleCloudStoragePath(original);
    const back = fromGoogleCloudStoragePath(googleCloudStoragePath);
    expect(back).toBe(original);
  });

  it('path with spaces roundtrips', () => {
    const original = 'dir/file with spaces.txt';
    const googleCloudStoragePath = toGoogleCloudStoragePath(original, 'prefix');
    const back = fromGoogleCloudStoragePath(googleCloudStoragePath, 'prefix');
    expect(back).toBe(original);
  });
});
