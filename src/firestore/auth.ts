import { readFileSync } from 'node:fs';
import type { FirestoreAuth } from '../core/index.js';
import { AuthenticationError, ConnectionError } from '../core/index.js';

const CONNECTOR_NAME = 'firestore';

/**
 * Result of resolving Firestore auth configuration.
 * Contains the credential and optional app options for firebase-admin initialization.
 */
export interface ResolvedAuth {
  credential?: unknown;
  projectId?: string;
}

/**
 * Resolve a FirestoreAuth config into firebase-admin App initialization options.
 *
 * Dynamically imports `firebase-admin` to avoid hard dependency.
 * Throws `ConnectionError` if the SDK is not installed.
 *
 * @param auth - Auth configuration (defaults to auto if undefined).
 * @returns Resolved auth with credential and optional projectId.
 * @throws {ConnectionError} When firebase-admin is not installed.
 * @throws {AuthenticationError} When service account key file cannot be read or parsed.
 *
 * @example
 * ```typescript
 * const resolved = await resolveAuth({ type: 'auto' });
 * // { credential: applicationDefault() }
 *
 * const resolved2 = await resolveAuth({ type: 'service-account', keyFilePath: '/path/to/key.json' });
 * // { credential: cert(...), projectId: 'my-project' }
 * ```
 */
export async function resolveAuth(auth?: FirestoreAuth): Promise<ResolvedAuth> {
  let admin: typeof import('firebase-admin');
  try {
    admin = await import('firebase-admin');
  } catch {
    throw new ConnectionError(
      'firebase-admin SDK is not installed. ' +
        'Install it with: npm install firebase-admin',
      { connector: CONNECTOR_NAME }
    );
  }

  if (!auth || auth.type === 'auto') {
    return { credential: admin.credential.applicationDefault() };
  }

  if (auth.type === 'service-account') {
    let serviceAccount: Record<string, unknown>;
    try {
      const raw = readFileSync(auth.keyFilePath, 'utf-8');
      serviceAccount = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AuthenticationError(
        'Service account key file could not be read or parsed.',
        { connector: CONNECTOR_NAME }
      );
    }
    return {
      credential: admin.credential.cert(serviceAccount as Parameters<typeof admin.credential.cert>[0]),
      projectId: (serviceAccount['project_id'] as string) || undefined,
    };
  }

  if (auth.type === 'service-account-json') {
    const credentials = auth.credentials as Record<string, unknown>;
    return {
      credential: admin.credential.cert(credentials as Parameters<typeof admin.credential.cert>[0]),
      projectId: (credentials['project_id'] as string) || undefined,
    };
  }

  // Exhaustive check
  const _exhaustive: never = auth;
  throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}

