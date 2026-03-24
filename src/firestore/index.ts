export type { FirestoreAuth } from '../core/index.js';
export type { FirestoreOptions } from './types.js';
export { FirestoreConnector } from './connector.js';

import { FirestoreConnector } from './connector.js';
import type { FirestoreOptions } from './types.js';

/**
 * Create a Firestore connector instance.
 *
 * @param options - Connection options (projectId, databaseId). All fields are optional.
 * @returns An unconnected FirestoreConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createFirestoreConnector } from 'venomous-datasource/firestore';
 *
 * const connector = createFirestoreConnector({ projectId: 'my-project' });
 * await connector.connect({ type: 'auto' });
 *
 * const collections = await connector.collections();
 * const preview = await connector.peek('users', { rows: 5 });
 *
 * await connector.disconnect();
 * ```
 */
export function createFirestoreConnector(options?: FirestoreOptions): FirestoreConnector {
  return new FirestoreConnector(options);
}
