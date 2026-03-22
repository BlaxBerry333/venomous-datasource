/**
 * Options for paginated requests.
 */
export interface PageOptions {
  /** Number of items per page. Default: 50, Max: 1000. */
  readonly size?: number;
  /** Opaque cursor returned from a previous request. */
  readonly cursor?: string;
}

/**
 * Paginated result container.
 * @typeParam T - The type of items in the result set.
 */
export interface PageResult<T> {
  /** Items for the current page. */
  readonly data: T[];
  /** Opaque cursor for the next page. `undefined` when no more data. */
  readonly nextCursor?: string;
  /** Whether more pages are available. */
  readonly hasMore: boolean;
  /** Total count of items (not all data sources support this). */
  readonly total?: number;
}
