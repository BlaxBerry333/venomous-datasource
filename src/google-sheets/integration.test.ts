import { describe, it, expect } from 'vitest';
import { createSheetsConnector } from './index.js';

/**
 * Integration tests for Google Sheets connector.
 * These tests require real Google credentials and a spreadsheet.
 *
 * To run: set SHEETS_SPREADSHEET_ID env var
 * and remove the .skip from describe.
 */
describe.skip('Sheets Integration Tests', () => {
  const spreadsheetId = process.env['SHEETS_SPREADSHEET_ID'] ?? '';

  it('connects and lists sheets', async () => {
    const connector = createSheetsConnector({ spreadsheetId });

    await connector.connect({ type: 'auto' });
    const tables = await connector.tables();

    expect(Array.isArray(tables)).toBe(true);
    expect(tables.length).toBeGreaterThan(0);

    await connector.disconnect();
  });

  it('peeks at a sheet', async () => {
    const connector = createSheetsConnector({ spreadsheetId });

    await connector.connect();
    const tables = await connector.tables();

    if (tables.length > 0) {
      const result = await connector.peek(tables[0]!.name, { rows: 5 });
      expect(result.data.length).toBeLessThanOrEqual(5);
    }

    await connector.disconnect();
  });

  it('finds with filter', async () => {
    const connector = createSheetsConnector({ spreadsheetId });

    await connector.connect();
    const tables = await connector.tables();

    if (tables.length > 0) {
      const result = await connector.find(tables[0]!.name, {
        page: { size: 5 },
      });
      expect(result.data.length).toBeLessThanOrEqual(5);
    }

    await connector.disconnect();
  });

  it('sql() throws QueryError', async () => {
    const connector = createSheetsConnector({ spreadsheetId });

    expect(() => connector.sql('SELECT 1')).toThrow();

    // No need to connect for sql()
  });
});
