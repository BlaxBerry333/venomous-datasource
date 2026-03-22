/**
 * Google Sheets connector connection options.
 */
export interface SheetsOptions {
  /**
   * Google Spreadsheet ID.
   * Extract from URL: `https://docs.google.com/spreadsheets/d/{spreadsheetId}/...`
   */
  readonly spreadsheetId: string;

  /**
   * Header row number (1-based). Defaults to 1.
   * Set to 0 for no header row (columns will use A/B/C... naming).
   */
  readonly headerRow?: number;
}
