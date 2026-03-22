import type { PageOptions } from './pagination.js';

/**
 * Supported comparison operators for WHERE clauses.
 */
export type WhereOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'like';

/**
 * A single WHERE condition.
 *
 * The `value` type depends on the operator:
 * - `eq`, `ne`, `gt`, `lt`, `gte`, `lte`: `string | number | boolean | null`
 * - `in`: `unknown[]` (array of values)
 * - `like`: `string` (SQL LIKE pattern with `%` and `_` wildcards)
 *
 * Type validation is deferred to the connector at runtime.
 */
export interface WhereCondition {
  readonly field: string;
  readonly operator: WhereOperator;
  readonly value: unknown;
}

/**
 * WHERE clause: an array of conditions combined with AND.
 * For OR logic, use `sql()` instead.
 */
export type WhereClause = WhereCondition[];

/**
 * ORDER BY direction.
 */
export type OrderDirection = 'asc' | 'desc';

/**
 * A single ORDER BY clause.
 */
export interface OrderByClause {
  readonly field: string;
  readonly direction: OrderDirection;
}

/**
 * Options for `find()` queries.
 */
export interface FindOptions {
  readonly where?: WhereClause;
  readonly orderBy?: OrderByClause[];
  readonly page?: PageOptions;
}

/**
 * Options for `peek()` preview.
 */
export interface PeekOptions {
  /** Number of rows to preview. Default: 10. */
  readonly rows?: number;
}

/**
 * Options for `files()` listing.
 */
export interface ListOptions {
  readonly page?: PageOptions;
}

/**
 * Options for `update()`.
 */
export interface UpdateOptions {
  readonly where: WhereClause;
  readonly set: Record<string, unknown>;
}

/**
 * Options for `remove()` on tabular data.
 */
export interface WhereOptions {
  readonly where: WhereClause;
}
