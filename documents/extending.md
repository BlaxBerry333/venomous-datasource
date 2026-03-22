# Extending venomous-datasource

Build custom connectors that integrate seamlessly with the venomous-datasource ecosystem.

---

## Overview

The `venomous-datasource/core` module exports everything you need: interfaces, types, error classes, and utility functions. Your connector just needs to implement `TabularConnector` or `FileConnector`.

## Requirements

A well-behaved connector must:

1. **Implement `TabularConnector` or `FileConnector`** from `venomous-datasource/core`
2. **Support `{ type: 'auto' }` authentication** — delegate to the native SDK's credential chain
3. **Wrap native SDK errors as `VenomousError` subclasses** — don't leak raw SDK errors
4. **Redact credentials** in logs and error output (use the provided `redactAuth()` utility)
5. **For file connectors:** validate paths with `normalizePath()` / `isPathSafe()` to prevent traversal attacks

## Example: Tabular Connector

```typescript
import type {
  TabularConnector,
  FindOptions,
  PageResult,
  Row,
  TableInfo,
  PeekResult,
} from 'venomous-datasource/core';
import {
  VenomousError,
  AuthenticationError,
  ConnectionError,
  QueryError,
} from 'venomous-datasource/core';

// 1. Define your auth type (must include 'auto')
type MyAuth = { type: 'auto' } | { type: 'password'; host: string; user: string; password: string };

// 2. Define your connector options
interface MyOptions {
  database: string;
  port?: number;
}

// 3. Implement the interface
class MyConnector implements TabularConnector<MyAuth> {
  private client: MyNativeClient | null = null;

  constructor(private readonly options: MyOptions) {}

  async connect(auth?: MyAuth): Promise<void> {
    const resolved = auth ?? { type: 'auto' };
    try {
      this.client = await createNativeClient(this.options, resolved);
    } catch (err) {
      // Wrap native errors
      throw new AuthenticationError('Failed to connect', {
        connector: 'my-source',
        cause: err,
      });
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async tables(): Promise<TableInfo[]> {
    /* ... */
  }
  async peek(table: string, options?: { rows?: number }): Promise<PeekResult> {
    /* ... */
  }
  async find(table: string, options?: FindOptions): Promise<PageResult<Row>> {
    /* ... */
  }
  async *sql(query: string, params?: unknown[]): AsyncIterable<Row> {
    /* ... */
  }
}

// 4. Export a factory function
export function createMyConnector(options: MyOptions): TabularConnector<MyAuth> {
  return new MyConnector(options);
}
```

## Example: File Connector

```typescript
import type { FileConnector, ListOptions, PageResult, FileInfo, PeekResult } from 'venomous-datasource/core';
import { PathError, normalizePath, isPathSafe } from 'venomous-datasource/core';

class MyFileConnector implements FileConnector<MyAuth> {
  // In every method that takes a path:
  private validatePath(path: string): string {
    const normalized = normalizePath(path);
    if (!isPathSafe(normalized)) {
      throw new PathError(`Unsafe path: ${path}`, { connector: 'my-storage' });
    }
    return normalized;
  }

  async files(path?: string, options?: ListOptions): Promise<PageResult<FileInfo>> {
    const safePath = this.validatePath(path ?? '');
    // ... list files using native SDK
  }

  // ... implement remaining methods
}
```

## Available Utilities

All utilities are re-exported from `venomous-datasource/core`:

| Utility                  | Purpose                         |
| ------------------------ | ------------------------------- |
| `normalizePath(path)`    | Normalize file paths            |
| `isPathSafe(path)`       | Guard against path traversal    |
| `encodeCJK(path)`        | NFC-normalize CJK filenames     |
| `redactAuth(auth, additionalFields?)` | Scrub credentials from objects  |
| `sanitizeError(error)`   | Safe error serialization        |
| `validatePageSize(size)` | Clamp to valid range (1–1000)   |
| `encodeCursor(value)`    | Create opaque pagination cursor |
| `decodeCursor(cursor)`   | Decode opaque pagination cursor |
| `parseCsv(content, max)` | Parse CSV text into rows + columns |
| `parseJson(content, max)`| Parse JSON/JSONL into rows (safe) |
| `getFileFormat(path)`    | Detect format from file extension |

See [API Reference](api-reference.md) for full type signatures.
