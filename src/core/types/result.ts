/**
 * A single row of tabular data.
 */
export type Row = Record<string, unknown>;

/**
 * Column metadata.
 */
export interface ColumnInfo {
  /** Column name. */
  readonly name: string;
  /** Native type string from the data source. */
  readonly type: string;
  /** Whether the column allows NULL values. */
  readonly nullable: boolean;
  /** Optional description/comment for the column. */
  readonly description?: string;
}

/**
 * Table metadata.
 */
export interface TableInfo {
  /** Table name. */
  readonly name: string;
  /** Column schema (not all data sources provide this eagerly). */
  readonly schema?: ColumnInfo[];
  /** Approximate row count (not all data sources support this). */
  readonly rowCount?: number;
}

/**
 * File metadata.
 */
export interface FileInfo {
  /** File name (without directory path). */
  readonly name: string;
  /** Full path relative to bucket/container root. */
  readonly path: string;
  /** File size in bytes. */
  readonly size: number;
  /** Last modification timestamp. */
  readonly lastModified: Date;
  /** MIME type (if available). */
  readonly contentType?: string;
  /** Whether this entry is a directory/prefix. */
  readonly isDirectory: boolean;
}

/**
 * Result of a `peek()` operation.
 */
export interface PeekResult {
  /** Preview rows. */
  readonly data: Row[];
  /** Column metadata (if available). */
  readonly columns?: ColumnInfo[];
  /** Total row count in the source (if available). */
  readonly totalRows?: number;
}

/**
 * Result of an `insert()` operation.
 */
export interface InsertResult {
  /** Number of rows inserted. */
  readonly insertedCount: number;
}

/**
 * Result of an `update()` operation.
 */
export interface UpdateResult {
  /** Number of rows updated. */
  readonly updatedCount: number;
}

/**
 * Result of a `remove()` operation on tabular data.
 */
export interface DeleteResult {
  /** Number of rows deleted. */
  readonly deletedCount: number;
}

/**
 * Result of a `write()` operation on file data.
 */
export interface WriteResult {
  /** Full path of the written file. */
  readonly path: string;
  /** Size of the written file in bytes. */
  readonly size: number;
}
