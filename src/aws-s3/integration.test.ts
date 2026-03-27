import { describe, it, expect } from 'vitest';
import { createAWSS3Connector } from './index.js';

/**
 * Integration tests for AWSS3Connector.
 *
 * These tests require real AWS credentials and an S3 bucket.
 * They are skipped by default and intended for local development verification.
 *
 * To run:
 * 1. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION env vars
 * 2. Set S3_TEST_BUCKET env var
 * 3. Remove .skip from the describe block
 *
 * CJK path end-to-end verification:
 * - Write a file with CJK filename
 * - List files and verify CJK name is decoded correctly
 * - Read the file back
 * - Delete the file
 */
describe.skip('AWSS3Connector integration', () => {
  const bucket = process.env['S3_TEST_BUCKET'] ?? 'test-bucket';
  const region = process.env['AWS_REGION'] ?? 'us-east-1';

  const connector = createAWSS3Connector({
    bucket,
    prefix: 'venomous-test',
    region,
  });

  const integrationAuth = {
    type: 'access-key' as const,
    accessKeyId: process.env['AWS_ACCESS_KEY_ID']!,
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY']!,
    region,
  };

  it('connects with access-key credentials', async () => {
    await connector.connect(integrationAuth);
    await connector.disconnect();
  });

  it('writes and reads a file', async () => {
    await connector.connect(integrationAuth);

    await connector.write!('test-file.txt', 'Hello, S3!');
    const stat = await connector.stat('test-file.txt');
    expect(stat.size).toBeGreaterThan(0);

    const stream = await connector.read('test-file.txt');
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('Hello, S3!');

    await connector.remove!('test-file.txt');
    await connector.disconnect();
  });

  it('lists files with pagination', async () => {
    await connector.connect(integrationAuth);

    const result = await connector.files(undefined, { page: { size: 10 } });
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);

    await connector.disconnect();
  });

  it('handles CJK filenames end-to-end', async () => {
    await connector.connect(integrationAuth);

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

    // Verify files listing shows decoded name
    const listing = await connector.files();
    const found = listing.data.find((f) => f.name === jpName);
    expect(found).toBeDefined();

    // Clean up
    await connector.remove!(jpName);
    await connector.disconnect();
  });

  it('handles Chinese filenames end-to-end', async () => {
    await connector.connect(integrationAuth);

    const cnName = '数据文件.json';
    await connector.write!(cnName, JSON.stringify([{ key: '中文' }]));

    const stat = await connector.stat(cnName);
    expect(stat.name).toBe(cnName);

    const peek = await connector.peek(cnName);
    expect(peek.data[0]).toEqual({ key: '中文' });

    await connector.remove!(cnName);
    await connector.disconnect();
  });
});
