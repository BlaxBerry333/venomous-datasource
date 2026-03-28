import type { MongoDBAuth } from '../core/index.js';
import { AuthenticationError, ConnectionError } from '../core/index.js';

const CONNECTOR_NAME = 'mongodb';
const DEFAULT_PORT = 27017;

/**
 * Result of resolving MongoDB auth configuration.
 * Contains the connection URI and optional MongoClient options.
 */
export interface ResolvedAuth {
  uri: string;
  options?: Record<string, unknown>;
}

/**
 * Resolve a MongoDBAuth config into a connection URI and MongoClient options.
 *
 * Dynamically imports the `mongodb` SDK to verify it is installed.
 * Throws `ConnectionError` if the SDK is not available.
 *
 * @param auth - Auth configuration. When omitted, connects to localhost:27017.
 * @returns Resolved auth with URI and optional client options.
 * @throws {ConnectionError} When the mongodb SDK is not installed.
 * @throws {AuthenticationError} When the connection string has an invalid prefix.
 *
 * @example
 * ```typescript
 * const resolved = await resolveAuth();
 * // { uri: 'mongodb://localhost:27017' }
 *
 * const resolved2 = await resolveAuth({ type: 'connection-string', connectionString: 'mongodb+srv://...' });
 * // { uri: 'mongodb+srv://...' }
 * ```
 */
export async function resolveAuth(auth?: MongoDBAuth): Promise<ResolvedAuth> {
  // Verify mongodb SDK is installed
  try {
    await import('mongodb');
  } catch {
    throw new ConnectionError(
      'mongodb SDK is not installed. Install it with: npm install mongodb',
      { connector: CONNECTOR_NAME }
    );
  }

  if (!auth) {
    return { uri: `mongodb://localhost:${DEFAULT_PORT}` };
  }

  if (auth.type === 'connection-string') {
    if (
      !auth.connectionString.startsWith('mongodb://') &&
      !auth.connectionString.startsWith('mongodb+srv://')
    ) {
      throw new AuthenticationError(
        'Invalid MongoDB connection string: URI must start with "mongodb://" or "mongodb+srv://".',
        { connector: CONNECTOR_NAME }
      );
    }
    return { uri: auth.connectionString };
  }

  if (auth.type === 'credentials') {
    const encodedUsername = encodeURIComponent(auth.username);
    const encodedPassword = encodeURIComponent(auth.password);
    const port = auth.port ?? DEFAULT_PORT;
    let uri = `mongodb://${encodedUsername}:${encodedPassword}@${auth.host}:${port}`;

    if (auth.authSource) {
      uri += `/?authSource=${encodeURIComponent(auth.authSource)}`;
    }

    return { uri };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}
