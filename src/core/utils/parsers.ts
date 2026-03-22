import type { ColumnInfo, Row } from '../types/result.js';
import { QueryError } from '../errors/query.js';

/**
 * Parse a CSV string according to RFC 4180.
 * Handles: quoted fields, commas inside quotes, newlines inside quotes, escaped quotes ("").
 *
 * @param content - Raw CSV string content.
 * @param maxRows - Maximum number of data rows to return (excluding header).
 * @returns Object with columns and data rows.
 */
export function parseCsv(content: string, maxRows: number): { columns: ColumnInfo[]; data: Row[] } {
  // Strip BOM if present
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const rows = parseCsvRows(text, maxRows + 1); // +1 for header

  if (rows.length === 0) {
    return { columns: [], data: [] };
  }

  const headerRow = rows[0]!;
  const columns: ColumnInfo[] = headerRow.map((name) => ({
    name: name.trim(),
    type: 'string',
    nullable: true,
  }));

  const data: Row[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const record: Row = {};
    for (let j = 0; j < columns.length; j++) {
      record[columns[j]!.name] = j < row.length ? row[j] : null;
    }
    data.push(record);
  }

  return { columns, data };
}

/**
 * Parse CSV text into arrays of string arrays (rows of fields).
 * RFC 4180 compliant: handles quoted fields with embedded commas and newlines.
 */
function parseCsvRows(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let pos = 0;
  const len = text.length;

  while (pos < len && rows.length < maxRows) {
    const { fields, nextPos } = parseCsvLine(text, pos);
    rows.push(fields);
    pos = nextPos;
  }

  return rows;
}

/**
 * Parse one CSV line starting at position `pos`.
 * Returns the parsed fields and the position after the line terminator.
 */
function parseCsvLine(text: string, pos: number): { fields: string[]; nextPos: number } {
  const fields: string[] = [];
  const len = text.length;

  while (pos <= len) {
    if (pos === len) {
      // End of text, push empty field only if we just saw a comma
      if (fields.length > 0) break;
      fields.push('');
      break;
    }

    const char = text[pos];

    if (char === '"') {
      // Quoted field
      let value = '';
      pos++; // skip opening quote
      while (pos < len) {
        if (text[pos] === '"') {
          if (pos + 1 < len && text[pos + 1] === '"') {
            // Escaped quote
            value += '"';
            pos += 2;
          } else {
            // Closing quote
            pos++; // skip closing quote
            break;
          }
        } else {
          value += text[pos];
          pos++;
        }
      }
      fields.push(value);

      // After closing quote, expect comma or line terminator
      if (pos < len && text[pos] === ',') {
        pos++; // skip comma
        // If at end of text after comma, push empty trailing field
        if (pos === len) {
          fields.push('');
        }
      } else if (pos < len && text[pos] === '\r') {
        pos++;
        if (pos < len && text[pos] === '\n') pos++;
        break;
      } else if (pos < len && text[pos] === '\n') {
        pos++;
        break;
      } else {
        // End of text
        break;
      }
    } else if (char === ',') {
      // Empty field before comma
      fields.push('');
      pos++; // skip comma
      // If at end of text after comma, push empty trailing field
      if (pos === len) {
        fields.push('');
      }
    } else if (char === '\r' || char === '\n') {
      // Empty line or end of unquoted line
      if (fields.length === 0) {
        fields.push('');
      }
      if (char === '\r') {
        pos++;
        if (pos < len && text[pos] === '\n') pos++;
      } else {
        pos++;
      }
      break;
    } else {
      // Unquoted field
      let value = '';
      while (pos < len && text[pos] !== ',' && text[pos] !== '\r' && text[pos] !== '\n') {
        value += text[pos];
        pos++;
      }
      fields.push(value);

      if (pos < len && text[pos] === ',') {
        pos++; // skip comma
        // If at end of text after comma, push empty trailing field
        if (pos === len) {
          fields.push('');
        }
      } else if (pos < len && text[pos] === '\r') {
        pos++;
        if (pos < len && text[pos] === '\n') pos++;
        break;
      } else if (pos < len && text[pos] === '\n') {
        pos++;
        break;
      } else {
        // End of text
        break;
      }
    }
  }

  return { fields, nextPos: pos };
}

/**
 * Parse JSON content for peek.
 * Supports JSON arrays and JSONL (newline-delimited JSON).
 *
 * Security: JSON.parse errors are not propagated as cause to avoid
 * leaking file content in error messages.
 */
export function parseJson(content: string, maxRows: number): { data: Row[] } {
  const text = content.trim();

  // Try JSON array first
  // Performance note: parses entire JSON array (up to 50MB) before slicing.
  // Memory usage can be 4-10x the JSON text size. Consider streaming JSON parser in future.
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new QueryError('Failed to parse JSON array');
    }
    if (!Array.isArray(parsed)) {
      throw new QueryError('Expected JSON array');
    }
    return { data: parsed.slice(0, maxRows) as Row[] };
  }

  // JSONL: one JSON object per line.
  // Each line is wrapped in try-catch to prevent native SyntaxError (which may
  // contain file content) from leaking when parseJson is called directly as an
  // exported function without connector-level error wrapping.
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const data: Row[] = [];
  for (const line of lines) {
    if (data.length >= maxRows) break;
    try {
      data.push(JSON.parse(line) as Row);
    } catch {
      throw new QueryError(`Failed to parse JSONL at line ${data.length + 1}`);
    }
  }
  return { data };
}

/**
 * Determine file format from extension.
 */
export function getFileFormat(path: string): 'csv' | 'json' | 'jsonl' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  return null;
}
