import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createBigQueryConnector } from './index.js';

/**
 * Integration tests for BigQuery connector.
 * These tests require real BigQuery credentials and are skipped by default.
 *
 * To run: set BIGQUERY_PROJECT_ID, BIGQUERY_DATASET_ID, BIGQUERY_KEY_FILE env vars
 * and remove the .skip from describe.
 */
describe.skip('BigQuery Integration Tests', () => {
  const projectId = process.env['BIGQUERY_PROJECT_ID'] ?? '';
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? '';
  const keyFilePath = process.env['BIGQUERY_KEY_FILE'] ?? '';

  function loadCredentials(): object {
    return JSON.parse(readFileSync(keyFilePath, 'utf-8')) as object;
  }

  it('connects and lists tables', async () => {
    const connector = createBigQueryConnector({ projectId, datasetId });

    await connector.connect({ type: 'credentials', credentials: loadCredentials() });
    const tables = await connector.tables();

    expect(Array.isArray(tables)).toBe(true);

    await connector.disconnect();
  });

  it('peeks at a table', async () => {
    const connector = createBigQueryConnector({ projectId, datasetId });

    await connector.connect({ type: 'credentials', credentials: loadCredentials() });
    const tables = await connector.tables();

    if (tables.length > 0) {
      const result = await connector.peek(tables[0]!.name, { rows: 5 });
      expect(result.data.length).toBeLessThanOrEqual(5);
    }

    await connector.disconnect();
  });

  it('executes raw SQL', async () => {
    const connector = createBigQueryConnector({ projectId, datasetId });

    await connector.connect({ type: 'credentials', credentials: loadCredentials() });

    const rows: Array<Record<string, unknown>> = [];
    for await (const row of connector.sql('SELECT 1 AS test_col')) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('test_col');

    await connector.disconnect();
  });
});
