export type { SheetsAuth } from '../core/index.js';
export type { SheetsOptions } from './types.js';
export { SheetsConnector } from './connector.js';

import { SheetsConnector } from './connector.js';
import type { SheetsOptions } from './types.js';

/**
 * Create a Google Sheets connector instance.
 *
 * @param options - Connection options (spreadsheetId, headerRow).
 * @returns An unconnected SheetsConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createSheetsConnector } from 'venomous-datasource/google-sheets';
 *
 * const connector = createSheetsConnector({
 *   spreadsheetId: 'abc123def456...',
 * });
 * await connector.connect(); // uses ADC
 * const sheets = await connector.tables();
 * const preview = await connector.peek(sheets[0].name, { rows: 5 });
 * await connector.disconnect();
 * ```
 */
export function createSheetsConnector(options: SheetsOptions): SheetsConnector {
  return new SheetsConnector(options);
}
