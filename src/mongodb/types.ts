/**
 * Options for creating a MongoDB connector.
 */
export interface MongoDBOptions {
  /** Database name. Required -- MongoDB operations are bound to a specific database. */
  readonly database: string;
  /** Connection timeout in milliseconds. Default: 10000. */
  readonly connectTimeoutMS?: number;
  /** Server selection timeout in milliseconds. Default: 10000. */
  readonly serverSelectionTimeoutMS?: number;
}
