import { describe, it, expect } from 'vitest';
import { createGoogleCloudStorageConnector } from './index.js';

/**
 * Integration tests for GoogleCloudStorageConnector.
 *
 * These tests require real GCP credentials and a Google Cloud Storage bucket.
 * They are skipped by default and intended for local development verification.
 *
 * To run:
 * 1. Set GOOGLE_CLOUD_STORAGE_CREDENTIALS env var (JSON string of service account key)
 * 2. Set GOOGLE_CLOUD_STORAGE_TEST_BUCKET env var
 * 3. Remove .skip from the describe block
 *
 * CJK path end-to-end verification:
 * - Write a file with CJK filename (no percent-encoding on Google Cloud Storage)
 * - List files and verify CJK name is preserved as-is
 * - Read the file back
 * - Delete the file
 */
describe.skip('GoogleCloudStorageConnector integration', () => {
  const bucket = process.env['GOOGLE_CLOUD_STORAGE_TEST_BUCKET'] ?? 'test-bucket';
  const projectId = process.env['GCP_PROJECT_ID'];
  const credentialsAuth = {
    credentials: JSON.parse(process.env['GOOGLE_CLOUD_STORAGE_CREDENTIALS'] ?? '{}'),
  };

  const connector = createGoogleCloudStorageConnector({
    bucket,
    prefix: 'venomous-test',
    projectId,
  });

  it('connects with credentials', async () => {
    await connector.connect(credentialsAuth);
    await connector.disconnect();
  });

  it('writes and reads a file', async () => {
    await connector.connect(credentialsAuth);

    await connector.write!('test-file.txt', 'Hello, Google Cloud Storage!');
    const stat = await connector.stat('test-file.txt');
    expect(stat.size).toBeGreaterThan(0);

    const stream = await connector.read('test-file.txt');
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('Hello, Google Cloud Storage!');

    await connector.remove!('test-file.txt');
    await connector.disconnect();
  });

  it('lists files with pagination', async () => {
    await connector.connect(credentialsAuth);

    const result = await connector.files(undefined, { page: { size: 10 } });
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);

    await connector.disconnect();
  });

  it('handles CJK filenames end-to-end (no encoding)', async () => {
    await connector.connect(credentialsAuth);

    // Write file with Japanese name -- Google Cloud Storage stores as-is (UTF-8, no encoding)
    const jpName = '日本語テスト.csv';
    const csvContent = 'name,value\nテスト,1';
    await connector.write!(jpName, csvContent);

    // Verify stat
    const stat = await connector.stat(jpName);
    expect(stat.name).toBe(jpName);

    // Verify peek
    const peek = await connector.peek(jpName);
    expect(peek.data[0]).toEqual({ name: 'テスト', value: '1' });

    // Verify files listing shows original CJK name (not percent-encoded)
    const listing = await connector.files();
    const found = listing.data.find((f) => f.name === jpName);
    expect(found).toBeDefined();

    // Clean up
    await connector.remove!(jpName);
    await connector.disconnect();
  });

  it('handles Chinese filenames end-to-end', async () => {
    await connector.connect(credentialsAuth);

    const cnName = '数据文件.json';
    await connector.write!(cnName, JSON.stringify([{ key: '中文' }]));

    const stat = await connector.stat(cnName);
    expect(stat.name).toBe(cnName);

    const peek = await connector.peek(cnName);
    expect(peek.data[0]).toEqual({ key: '中文' });

    await connector.remove!(cnName);
    await connector.disconnect();
  });

  it('verifies NFC normalization consistency', async () => {
    await connector.connect(credentialsAuth);

    // Write with NFC name
    const nfcName = 'r\u00e9sum\u00e9.csv';
    await connector.write!(nfcName, 'col1\nval1');

    // Read with NFD name (should resolve to same key after normalization)
    const nfdName = 're\u0301sume\u0301.csv';
    const stat = await connector.stat(nfdName);
    expect(stat.size).toBeGreaterThan(0);

    await connector.remove!(nfcName);
    await connector.disconnect();
  });
});
