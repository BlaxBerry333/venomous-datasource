import { describe, it, expect } from 'vitest';
import { createAzureBlobConnector } from './index.js';

/**
 * Integration tests for AzureBlobConnector.
 *
 * These tests require real Azure credentials and a Blob Storage container.
 * They are skipped by default and intended for local development verification.
 *
 * To run:
 * 1. Set AZURE_STORAGE_CONNECTION_STRING env var (or use az login for DefaultAzureCredential)
 * 2. Set AZURE_TEST_CONTAINER env var
 * 3. Set AZURE_TEST_ACCOUNT_NAME env var (for auto auth mode)
 * 4. Remove .skip from the describe block
 *
 * CJK path end-to-end verification:
 * - Write a file with CJK filename (no percent-encoding on Azure Blob)
 * - List files and verify CJK name is preserved as-is
 * - Read the file back
 * - Delete the file
 */
describe.skip('AzureBlobConnector integration', () => {
  const container = process.env['AZURE_TEST_CONTAINER'] ?? 'test-container';
  const accountName = process.env['AZURE_TEST_ACCOUNT_NAME'];
  const connectionString = process.env['AZURE_STORAGE_CONNECTION_STRING'];

  const connector = createAzureBlobConnector({
    container,
    prefix: 'venomous-test',
    accountName,
  });

  const auth = connectionString
    ? { type: 'connection-string' as const, connectionString }
    : undefined;

  it('connects with credentials', async () => {
    await connector.connect(auth);
    await connector.disconnect();
  });

  it('writes and reads a file', async () => {
    await connector.connect(auth);

    await connector.write!('test-file.txt', 'Hello, Azure Blob!');
    const stat = await connector.stat('test-file.txt');
    expect(stat.size).toBeGreaterThan(0);

    const stream = await connector.read('test-file.txt');
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('Hello, Azure Blob!');

    await connector.remove!('test-file.txt');
    await connector.disconnect();
  });

  it('lists files with pagination', async () => {
    await connector.connect(auth);

    const result = await connector.files(undefined, { page: { size: 10 } });
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);

    await connector.disconnect();
  });

  it('handles CJK filenames end-to-end (no encoding)', async () => {
    await connector.connect(auth);

    // Write file with Japanese name
    const jpName = '日本語テスト.csv';
    const csvContent = 'name,value\nテスト,1';
    await connector.write!(jpName, csvContent);

    // Verify stat
    const stat = await connector.stat(jpName);
    expect(stat.name).toBe(jpName);

    // Verify peek
    const peek = await connector.peek(jpName);
    expect(peek.data[0]).toEqual({ name: 'テスト', value: '1' });

    // Verify files listing shows original CJK name
    const listing = await connector.files();
    const found = listing.data.find((f) => f.name === jpName);
    expect(found).toBeDefined();

    // Clean up
    await connector.remove!(jpName);
    await connector.disconnect();
  });

  it('handles Chinese filenames end-to-end', async () => {
    await connector.connect(auth);

    const cnName = '数据文件.json';
    await connector.write!(cnName, JSON.stringify([{ key: '中文' }]));

    const stat = await connector.stat(cnName);
    expect(stat.name).toBe(cnName);

    const peek = await connector.peek(cnName);
    expect(peek.data[0]).toEqual({ key: '中文' });

    await connector.remove!(cnName);
    await connector.disconnect();
  });

  it('handles large file streaming', async () => {
    await connector.connect(auth);

    // Create a 1MB test file
    const content = 'x'.repeat(1024 * 1024);
    await connector.write!('large-test.txt', content);

    const stream = await connector.read('large-test.txt');
    const reader = stream.getReader();
    let totalBytes = 0;
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        totalBytes += result.value.length;
      }
    }
    expect(totalBytes).toBe(1024 * 1024);

    await connector.remove!('large-test.txt');
    await connector.disconnect();
  });
});
