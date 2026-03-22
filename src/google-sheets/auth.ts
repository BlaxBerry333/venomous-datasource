import type { SheetsAuth } from '../core/index.js';

/** Google Sheets API scope (full read/write access). */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Configuration object for GoogleAuth constructor.
 * Using a plain interface to avoid importing googleapis types at the module level
 * (googleapis is an optional peer dependency).
 */
interface GoogleAuthConfig {
  scopes: string[];
  keyFile?: string;
  credentials?: object;
}

/**
 * Resolve a SheetsAuth config into a GoogleAuth configuration object.
 *
 * The returned object is passed to `new google.auth.GoogleAuth(config)`.
 * The scope is always set to `https://www.googleapis.com/auth/spreadsheets`
 * (full read/write access), consistent with other Google connectors that
 * do not distinguish read-only vs read-write scopes.
 *
 * @param auth - Auth configuration (defaults to auto/ADC if undefined).
 * @returns Configuration object for GoogleAuth constructor.
 *
 * @example
 * ```typescript
 * const config = resolveAuth({ type: 'auto' });
 * // { scopes: ['https://www.googleapis.com/auth/spreadsheets'] }
 *
 * const config2 = resolveAuth({
 *   type: 'service-account',
 *   keyFilePath: '/path/to/key.json',
 * });
 * // { scopes: [...], keyFile: '/path/to/key.json' }
 * ```
 */
export function resolveAuth(auth?: SheetsAuth): GoogleAuthConfig {
  const base: GoogleAuthConfig = { scopes: [SHEETS_SCOPE] };

  if (!auth || auth.type === 'auto') {
    return base;
  }

  if (auth.type === 'service-account') {
    return { ...base, keyFile: auth.keyFilePath };
  }

  if (auth.type === 'service-account-json') {
    return { ...base, credentials: auth.credentials };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
