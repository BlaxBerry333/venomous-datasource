export type { MongoDBAuth } from '../core/index.js';
export type { MongoDBOptions } from './types.js';
export { MongoDBConnector } from './connector.js';

import { MongoDBConnector } from './connector.js';
import type { MongoDBOptions } from './types.js';

/**
 * Create a MongoDB connector instance.
 *
 * @param options - Connection options. `database` is required.
 * @returns An unconnected MongoDBConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createMongoDBConnector } from 'venomous-datasource/mongodb';
 *
 * const connector = createMongoDBConnector({ database: 'mydb' });
 * await connector.connect({ type: 'auto' });
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 *
 * await connector.disconnect();
 * ```
 */
export function createMongoDBConnector(options: MongoDBOptions): MongoDBConnector {
  return new MongoDBConnector(options);
}
