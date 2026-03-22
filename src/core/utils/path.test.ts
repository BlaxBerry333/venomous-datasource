import { describe, it, expect } from 'vitest';
import { normalizePath, isPathSafe, encodeCJK } from './path.js';
import { PathError } from '../errors/path.js';

describe('normalizePath', () => {
  describe('valid paths', () => {
    it('should pass through a simple path', () => {
      expect(normalizePath('data/file.csv')).toBe('data/file.csv');
    });

    it('should strip leading slash after conversion (path that becomes relative)', () => {
      // Absolute paths should throw, but trailing slashes should be stripped
      expect(normalizePath('data/file/')).toBe('data/file');
    });

    it('should strip trailing slashes', () => {
      expect(normalizePath('data/dir/')).toBe('data/dir');
    });

    it('should handle nested paths', () => {
      expect(normalizePath('a/b/c/d.txt')).toBe('a/b/c/d.txt');
    });

    it('should handle single segment', () => {
      expect(normalizePath('file.txt')).toBe('file.txt');
    });

    it('should return empty string for "."', () => {
      expect(normalizePath('.')).toBe('');
    });

    it('should handle paths with spaces', () => {
      expect(normalizePath('data/my file.csv')).toBe('data/my file.csv');
    });
  });

  describe('CJK and Unicode handling', () => {
    it('should handle Japanese characters', () => {
      expect(normalizePath('data/日本語ファイル.csv')).toBe('data/日本語ファイル.csv');
    });

    it('should handle Chinese characters', () => {
      expect(normalizePath('数据/文件.csv')).toBe('数据/文件.csv');
    });

    it('should normalize NFD to NFC', () => {
      // e-acute: NFD = U+0065 U+0301, NFC = U+00E9
      const nfd = 'caf\u0065\u0301.txt';
      const nfc = 'caf\u00e9.txt';
      expect(normalizePath(nfd)).toBe(nfc);
    });
  });

  describe('Windows paths', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizePath('data\\file.csv')).toBe('data/file.csv');
    });

    it('should handle mixed separators', () => {
      expect(normalizePath('data/sub\\file.csv')).toBe('data/sub/file.csv');
    });
  });

  describe('path traversal rejection', () => {
    it('should reject ../etc/passwd', () => {
      expect(() => normalizePath('../etc/passwd')).toThrow(PathError);
      expect(() => normalizePath('../etc/passwd')).toThrow('traversal');
    });

    it('should reject nested traversal', () => {
      expect(() => normalizePath('data/../../etc/passwd')).toThrow(PathError);
    });

    it('should reject URL-encoded traversal ..%2F', () => {
      expect(() => normalizePath('..%2Fetc/passwd')).toThrow(PathError);
    });

    it('should reject URL-encoded traversal ..%2f (lowercase)', () => {
      expect(() => normalizePath('..%2fetc/passwd')).toThrow(PathError);
    });

    it('should reject backslash traversal ..\\', () => {
      expect(() => normalizePath('..\\etc\\passwd')).toThrow(PathError);
    });

    it('should reject mid-path traversal', () => {
      expect(() => normalizePath('data/../../../etc/passwd')).toThrow(PathError);
    });

    const traversalCode = 'VENOMOUS_PATH_TRAVERSAL';
    it('should use correct error code for traversal', () => {
      try {
        normalizePath('../test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(PathError);
        expect((e as PathError).code).toBe(traversalCode);
      }
    });
  });

  describe('absolute path rejection', () => {
    it('should reject paths starting with /', () => {
      expect(() => normalizePath('/etc/passwd')).toThrow(PathError);
    });

    it('should use correct error code', () => {
      try {
        normalizePath('/absolute/path');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(PathError);
        expect((e as PathError).code).toBe('VENOMOUS_PATH_ABSOLUTE');
      }
    });
  });

  describe('empty path rejection', () => {
    it('should reject empty string', () => {
      expect(() => normalizePath('')).toThrow(PathError);
    });

    it('should reject whitespace-only string', () => {
      expect(() => normalizePath('   ')).toThrow(PathError);
    });

    it('should use correct error code', () => {
      try {
        normalizePath('');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(PathError);
        expect((e as PathError).code).toBe('VENOMOUS_PATH_EMPTY');
      }
    });
  });

  describe('path length limit', () => {
    it('should reject paths exceeding 1024 characters', () => {
      const longPath = 'a/'.repeat(513); // 1026 chars
      expect(() => normalizePath(longPath)).toThrow(PathError);
    });

    it('should accept paths at exactly 1024 characters', () => {
      const path = 'a'.repeat(1024);
      expect(() => normalizePath(path)).not.toThrow();
    });
  });

  describe('malformed URL encoding', () => {
    it('should handle invalid percent sequences gracefully', () => {
      // Invalid percent encoding like %ZZ should not crash
      expect(normalizePath('data/%ZZfile.csv')).toBe('data/%ZZfile.csv');
    });
  });

  describe('runtime defense for non-string input', () => {
    it('should throw PathError for null input', () => {
      expect(() => normalizePath(null as unknown as string)).toThrow(PathError);
    });

    it('should throw PathError for undefined input', () => {
      expect(() => normalizePath(undefined as unknown as string)).toThrow(PathError);
    });
  });

  describe('encoded traversal pattern detection', () => {
    it('should reject paths containing %2e%2e after decode', () => {
      // Double-encoded: %252e%252e%252f decodes to %2e%2e%2f (still contains encoded traversal)
      expect(() => normalizePath('%252e%252e%252fetc/passwd')).toThrow(PathError);
    });
  });
});

describe('isPathSafe', () => {
  it('should return true for safe paths', () => {
    expect(isPathSafe('data/file.csv')).toBe(true);
    expect(isPathSafe('simple.txt')).toBe(true);
  });

  it('should return false for traversal', () => {
    expect(isPathSafe('../etc/passwd')).toBe(false);
  });

  it('should return false for absolute path', () => {
    expect(isPathSafe('/etc/passwd')).toBe(false);
  });

  it('should return false for empty path', () => {
    expect(isPathSafe('')).toBe(false);
  });
});

describe('encodeCJK', () => {
  it('should encode Japanese characters', () => {
    const result = encodeCJK('data/日本語.csv');
    expect(result).toContain('data/');
    expect(result).toContain('.csv');
    expect(result).not.toContain('日');
    // Verify round-trip
    expect(decodeURIComponent(result)).toBe('data/日本語.csv');
  });

  it('should preserve ASCII characters and slashes', () => {
    expect(encodeCJK('data/file.csv')).toBe('data/file.csv');
  });

  it('should preserve path separators', () => {
    const result = encodeCJK('a/b/ファイル.csv');
    expect(result.split('/')).toHaveLength(3);
  });

  it('should handle empty string', () => {
    expect(encodeCJK('')).toBe('');
  });

  it('should encode Chinese characters', () => {
    const result = encodeCJK('数据/文件.txt');
    expect(decodeURIComponent(result)).toBe('数据/文件.txt');
  });
});
