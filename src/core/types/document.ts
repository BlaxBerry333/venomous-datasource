import type { OrderDirection } from './query.js';
import type { PageOptions } from './pagination.js';

/**
 * A document read from a document database.
 * The `id` is always present and separated from the document data.
 */
export interface Document {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

/**
 * A document to be written to a document database.
 * The `id` is optional -- omit it to let the database auto-generate one.
 */
export interface DocumentInput {
  readonly id?: string;
  readonly data: Record<string, unknown>;
}

/**
 * Collection metadata. Document databases are schema-less,
 * so only the name is available without sampling.
 */
export interface CollectionInfo {
  readonly name: string;
}

/**
 * Field information inferred by sampling documents.
 * Unlike `ColumnInfo` (schema-enforced), these fields are best-effort
 * and may not be present in every document.
 */
export interface FieldInfo {
  readonly name: string;
  /** Type string defined by each connector (e.g., 'STRING', 'NUMBER', 'TIMESTAMP'). */
  readonly type: string;
  /** Always `true` for document databases (any field can be absent in any document). */
  readonly nullable: boolean;
}

/**
 * Supported filter operators for document queries.
 * Does not include `like` -- document databases generally lack native LIKE support.
 */
export type DocFilterOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in';

/**
 * A single filter condition for document queries.
 */
export interface DocFilterCondition {
  readonly field: string;
  readonly operator: DocFilterOperator;
  readonly value: unknown;
}

/**
 * Filter conditions combined with AND logic.
 */
export type DocFilter = DocFilterCondition[];

/**
 * A single ORDER BY clause for document queries.
 * Reuses the universal `OrderDirection` type.
 */
export interface DocOrderByClause {
  readonly field: string;
  readonly direction: OrderDirection;
}

/**
 * Options for `find()` queries on document collections.
 */
export interface DocFindOptions {
  readonly filter?: DocFilter;
  readonly orderBy?: DocOrderByClause[];
  readonly page?: PageOptions;
}

/**
 * Options for `peek()` preview on document collections.
 */
export interface DocPeekOptions {
  /** Number of documents to preview. Default: 10. */
  readonly rows?: number;
}

/**
 * Result of a `peek()` operation on a document collection.
 */
export interface DocPeekResult {
  /** Preview documents. */
  readonly data: Document[];
  /** Field information inferred by sampling (not guaranteed to cover all documents). */
  readonly fields?: FieldInfo[];
  /** Total document count (most document databases do not support efficient counting). */
  readonly totalDocs?: number;
}

/**
 * Result of an `insert()` operation on a document collection.
 */
export interface DocInsertResult {
  /** Number of documents inserted. */
  readonly insertedCount: number;
  /** Actual document IDs used (user-specified or auto-generated). */
  readonly insertedIds: string[];
}

/**
 * Result of an `update()` operation on a document collection.
 */
export interface DocUpdateResult {
  /** Number of documents updated. */
  readonly updatedCount: number;
}

/**
 * Result of a `remove()` operation on a document collection.
 */
export interface DocDeleteResult {
  /** Number of documents deleted. */
  readonly deletedCount: number;
}

/**
 * Options for `update()` on a document collection.
 * `filter` is required and must be non-empty to prevent accidental mass updates.
 */
export interface DocUpdateOptions {
  readonly filter: DocFilter;
  readonly set: Record<string, unknown>;
}

/**
 * Options for `remove()` on a document collection.
 * `filter` is required and must be non-empty to prevent accidental mass deletes.
 */
export interface DocRemoveOptions {
  readonly filter: DocFilter;
}
