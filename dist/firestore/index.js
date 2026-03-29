import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, validatePageSize } from "../core/index.js";

//#region src/firestore/auth.ts
const CONNECTOR_NAME$1 = "firestore";
/**
* Resolve a FirestoreAuth config into firebase-admin App initialization options.
*
* Dynamically imports `firebase-admin` to avoid hard dependency.
* Throws `ConnectionError` if the SDK is not installed.
*
* @param auth - Auth configuration (defaults to auto if undefined).
* @returns Resolved auth with credential and optional projectId.
* @throws {ConnectionError} When firebase-admin is not installed.
*
* @example
* ```typescript
* const resolved = await resolveAuth({ type: 'auto' });
* // { credential: applicationDefault() }
*
* const resolved2 = await resolveAuth({ credentials: {...} });
* // { credential: cert(...), projectId: 'my-project' }
* ```
*/
async function resolveAuth(auth) {
	let admin;
	try {
		admin = await import("firebase-admin");
	} catch {
		throw new ConnectionError("firebase-admin SDK is not installed. Install it with: npm install firebase-admin", { connector: CONNECTOR_NAME$1 });
	}
	if (!auth || auth.type === "auto") return { credential: admin.credential.applicationDefault() };
	if (!auth.type || auth.type === "credentials") {
		const credentials = auth.credentials;
		return {
			credential: admin.credential.cert(credentials),
			projectId: credentials["project_id"] || void 0
		};
	}
	throw new Error(`Unknown auth type: ${JSON.stringify(auth)}`);
}

//#endregion
//#region src/firestore/connector.ts
const CONNECTOR_NAME = "firestore";
const DEFAULT_PEEK_ROWS = 10;
const DEFAULT_PAGE_SIZE = 50;
const BATCH_SIZE = 500;
const MAX_IN_ELEMENTS = 30;
/** Mapping from DocFilterOperator to Firestore WhereFilterOp. */
const OPERATOR_MAP = {
	eq: "==",
	ne: "!=",
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
	in: "in"
};
/**
* Firebase Firestore connector implementing the `DocumentConnector` interface.
*
* Maps Firestore's collection/document model to the unified document API.
* Uses `firebase-admin` SDK for server-side access.
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
* const doc = await connector.getById('users', 'user123');
*
* await connector.disconnect();
* ```
*/
var FirestoreConnector = class {
	options;
	app = null;
	db = null;
	connected = false;
	schemaCache = new Map();
	constructor(options) {
		this.options = options ?? {};
	}
	/**
	* Connect to Firestore and initialize the client.
	* Idempotent: if already connected, disconnects first then reconnects.
	*
	* @param auth - Authentication configuration. Defaults to `{ type: 'auto' }`.
	* @throws {ConnectionError} When firebase-admin is not installed or connection fails.
	* @throws {AuthenticationError} When credentials are invalid.
	* @throws {PermissionError} When credentials lack sufficient permissions.
	*/
	async connect(auth) {
		if (this.connected) await this.disconnect();
		const resolved = await resolveAuth(auth);
		const admin = await import("firebase-admin");
		const projectId = this.options.projectId ?? resolved.projectId;
		const appName = `venomous-firestore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			this.app = admin.initializeApp({
				credential: resolved.credential,
				projectId
			}, appName);
			const { getFirestore } = await import("firebase-admin/firestore");
			const databaseId = this.options.databaseId ?? "(default)";
			this.db = getFirestore(this.app, databaseId);
		} catch (err) {
			if (this.app) {
				try {
					await this.app.delete();
				} catch {}
				this.app = null;
			}
			throw wrapError(err, "Failed to initialize Firestore connection");
		}
		try {
			await this.db.listCollections();
		} catch (err) {
			if (this.app) {
				try {
					await this.app.delete();
				} catch {}
				this.app = null;
				this.db = null;
			}
			throw wrapError(err, "Failed to verify Firestore connection");
		}
		this.connected = true;
	}
	/**
	* Disconnect from Firestore and release all resources.
	* Idempotent: calling on an already-disconnected connector is a no-op.
	*/
	async disconnect() {
		this.schemaCache.clear();
		if (this.app) {
			try {
				await this.app.delete();
			} catch {}
			this.app = null;
		}
		this.db = null;
		this.connected = false;
	}
	/**
	* List all top-level collections.
	*
	* @returns Array of collection metadata (name only).
	*/
	async collections() {
		this.ensureConnected();
		try {
			const refs = await this.db.listCollections();
			return refs.map((ref) => ({ name: ref.id }));
		} catch (err) {
			throw wrapError(err, "Failed to list collections");
		}
	}
	/**
	* Preview the first N documents of a collection and infer field information.
	*
	* @param collection - Collection path (supports subcollections).
	* @param options - Preview options (default: 10 documents).
	* @returns Preview result with documents and optional inferred field info.
	*/
	async peek(collection, options) {
		this.ensureConnected();
		const rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		const limit = Math.max(1, Math.min(rows, 1e3));
		try {
			const colRef = this.db.collection(collection);
			const snapshot = await colRef.limit(limit).get();
			if (snapshot.empty) return { data: [] };
			const fields = this.schemaCache.get(collection) ?? inferFieldsFromSnapshots(snapshot.docs);
			const documents = snapshot.docs.map((doc) => documentToData(doc));
			this.schemaCache.set(collection, fields);
			return {
				data: documents,
				fields
			};
		} catch (err) {
			throw wrapError(err, `Failed to peek collection "${collection}"`);
		}
	}
	/**
	* Query documents with filtering, ordering, and pagination.
	*
	* @param collection - Collection path.
	* @param options - Query options (filter, orderBy, page).
	* @returns Paginated result set of documents.
	* @throws {QueryError} When the query is invalid.
	*/
	async find(collection, options) {
		this.ensureConnected();
		const filter = options?.filter;
		const orderBy = options?.orderBy;
		const pageSize = options?.page?.size ? validatePageSize(options.page.size).value : DEFAULT_PAGE_SIZE;
		const cursor = options?.page?.cursor;
		try {
			const colRef = this.db.collection(collection);
			let query = buildQuery(colRef, filter, orderBy);
			if (cursor) {
				const cursorState = decodeCursor(cursor);
				const lastDocPath = cursorState["lastDocPath"];
				if (!lastDocPath || typeof lastDocPath !== "string") throw new QueryError("Invalid cursor: missing lastDocPath", {
					code: "VENOMOUS_INVALID_CURSOR",
					connector: CONNECTOR_NAME
				});
				const lastDocRef = this.db.doc(lastDocPath);
				const lastDocSnapshot = await lastDocRef.get();
				if (!lastDocSnapshot.exists) throw new QueryError("Invalid cursor: the referenced document no longer exists. Please restart pagination.", {
					code: "VENOMOUS_INVALID_CURSOR",
					connector: CONNECTOR_NAME
				});
				query = query.startAfter(lastDocSnapshot);
			}
			const snapshot = await query.limit(pageSize + 1).get();
			const hasMore = snapshot.docs.length > pageSize;
			const docs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
			const data = docs.map((doc) => documentToData(doc));
			let nextCursor;
			if (hasMore && docs.length > 0) {
				const lastDoc = docs[docs.length - 1];
				nextCursor = encodeCursor({ lastDocPath: lastDoc.ref.path });
			}
			return {
				data,
				nextCursor,
				hasMore
			};
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to query collection "${collection}"`);
		}
	}
	/**
	* Get a single document by its ID.
	*
	* @param collection - Collection path.
	* @param id - Document ID (must not be empty or contain `/`).
	* @returns The document, or `null` if it does not exist.
	* @throws {QueryError} When the ID is invalid.
	*/
	async getById(collection, id) {
		this.ensureConnected();
		validateDocumentId(id);
		try {
			const docRef = this.db.collection(collection).doc(id);
			const snapshot = await docRef.get();
			if (!snapshot.exists) return null;
			return documentToData(snapshot);
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to get document "${id}" from "${collection}"`);
		}
	}
	/**
	* Insert documents into a collection.
	*
	* Uses WriteBatch internally (max 500 per batch). Multi-batch operations
	* are NOT atomic -- if a later batch fails, earlier batches are not rolled back.
	*
	* @param collection - Collection path.
	* @param docs - Array of documents to insert.
	* @returns Insert result with count and actual IDs used.
	* @throws {QueryError} When a document ID is invalid.
	*/
	async insert(collection, docs) {
		this.ensureConnected();
		if (docs.length === 0) return {
			insertedCount: 0,
			insertedIds: []
		};
		for (const doc of docs) if (doc.id !== void 0) validateDocumentId(doc.id);
		const colRef = this.db.collection(collection);
		const insertedIds = [];
		try {
			for (let i = 0; i < docs.length; i += BATCH_SIZE) {
				const batchDocs = docs.slice(i, i + BATCH_SIZE);
				const batch = this.db.batch();
				for (const doc of batchDocs) {
					let docRef;
					if (doc.id) docRef = colRef.doc(doc.id);
					else docRef = colRef.doc();
					batch.set(docRef, doc.data);
					insertedIds.push(docRef.id);
				}
				await batch.commit();
			}
			return {
				insertedCount: insertedIds.length,
				insertedIds
			};
		} catch (err) {
			throw wrapError(err, `Failed to insert documents into "${collection}"`);
		}
	}
	/**
	* Update documents matching a filter.
	*
	* Uses WriteBatch internally. The filter must be non-empty to prevent
	* accidental mass updates.
	*
	* **Performance warning**: All matching documents are loaded into memory before
	* batch updates are applied. For large result sets (tens of thousands of documents
	* or more), consider applying more selective filters or batching at the application
	* layer to avoid excessive memory usage and Firestore read quota consumption.
	*
	* @param collection - Collection path.
	* @param options - Update options with filter and set values.
	* @returns Update result with count.
	* @throws {QueryError} When the filter is empty.
	*/
	async update(collection, options) {
		this.ensureConnected();
		validateNonEmptyFilter(options.filter);
		try {
			const colRef = this.db.collection(collection);
			const query = buildQuery(colRef, options.filter);
			const snapshot = await query.get();
			if (snapshot.empty) return { updatedCount: 0 };
			const matchedDocs = snapshot.docs;
			for (let i = 0; i < matchedDocs.length; i += BATCH_SIZE) {
				const batchDocs = matchedDocs.slice(i, i + BATCH_SIZE);
				const batch = this.db.batch();
				for (const doc of batchDocs) batch.update(doc.ref, options.set);
				await batch.commit();
			}
			return { updatedCount: matchedDocs.length };
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to update documents in "${collection}"`);
		}
	}
	/**
	* Delete documents matching a filter.
	*
	* Uses WriteBatch internally. The filter must be non-empty to prevent
	* accidental mass deletes.
	*
	* **Performance warning**: All matching documents are loaded into memory before
	* batch deletes are applied. For large result sets (tens of thousands of documents
	* or more), consider applying more selective filters or batching at the application
	* layer to avoid excessive memory usage and Firestore read quota consumption.
	*
	* @param collection - Collection path.
	* @param options - Remove options with filter.
	* @returns Delete result with count.
	* @throws {QueryError} When the filter is empty.
	*/
	async remove(collection, options) {
		this.ensureConnected();
		validateNonEmptyFilter(options.filter);
		try {
			const colRef = this.db.collection(collection);
			const query = buildQuery(colRef, options.filter);
			const snapshot = await query.get();
			if (snapshot.empty) return { deletedCount: 0 };
			const matchedDocs = snapshot.docs;
			for (let i = 0; i < matchedDocs.length; i += BATCH_SIZE) {
				const batchDocs = matchedDocs.slice(i, i + BATCH_SIZE);
				const batch = this.db.batch();
				for (const doc of batchDocs) batch.delete(doc.ref);
				await batch.commit();
			}
			return { deletedCount: matchedDocs.length };
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to delete documents from "${collection}"`);
		}
	}
	/**
	* Ensure the connector is connected. Throws if not.
	*/
	ensureConnected() {
		if (!this.connected || !this.db) throw new ConnectionError("Not connected to Firestore. Call connect() first.", {
			code: "VENOMOUS_NOT_CONNECTED",
			connector: CONNECTOR_NAME
		});
	}
};
/**
* Validate that a document ID is valid (non-empty, no `/`).
*
* @param id - Document ID to validate.
* @throws {QueryError} When the ID is invalid.
*/
function validateDocumentId(id) {
	if (!id || id.length === 0) throw new QueryError("Document ID must not be empty.", {
		code: "VENOMOUS_INVALID_IDENTIFIER",
		connector: CONNECTOR_NAME
	});
	if (id.includes("/")) throw new QueryError(`Document ID must not contain "/". Got: "${id}"`, {
		code: "VENOMOUS_INVALID_IDENTIFIER",
		connector: CONNECTOR_NAME
	});
}
/**
* Validate that a filter is non-empty.
*
* @param filter - Filter to validate.
* @throws {QueryError} When the filter is empty.
*/
function validateNonEmptyFilter(filter) {
	if (!filter || filter.length === 0) throw new QueryError("Filter must not be empty for update/remove operations. This prevents accidental modification of all documents.", {
		code: "VENOMOUS_EMPTY_FILTER",
		connector: CONNECTOR_NAME
	});
}
/**
* Build a Firestore Query from filter conditions and orderBy clauses.
*
* @param colRef - Collection reference.
* @param filter - Optional filter conditions.
* @param orderBy - Optional orderBy clauses.
* @returns Constructed Firestore Query.
*/
function buildQuery(colRef, filter, orderBy) {
	let query = colRef;
	if (filter) for (const condition of filter) {
		const op = OPERATOR_MAP[condition.operator];
		if (!op) throw new QueryError(`Unsupported filter operator: "${condition.operator}"`, {
			code: "VENOMOUS_INVALID_QUERY",
			connector: CONNECTOR_NAME
		});
		if (condition.operator === "in") {
			if (!Array.isArray(condition.value)) throw new QueryError(`"in" operator requires an array value.`, {
				code: "VENOMOUS_INVALID_QUERY",
				connector: CONNECTOR_NAME
			});
			if (condition.value.length > MAX_IN_ELEMENTS) throw new QueryError(`"in" operator supports a maximum of ${MAX_IN_ELEMENTS} elements. Got: ${condition.value.length}`, {
				code: "VENOMOUS_INVALID_QUERY",
				connector: CONNECTOR_NAME
			});
		}
		query = query.where(condition.field, op, condition.value);
	}
	if (orderBy) for (const clause of orderBy) query = query.orderBy(clause.field, clause.direction);
	return query;
}
/**
* Convert a Firestore DocumentSnapshot to a `Document` with recursive
* type conversion for Firestore-specific types.
*
* @param snapshot - Firestore DocumentSnapshot.
* @returns Converted Document with id and data.
*/
function documentToData(snapshot) {
	const rawData = snapshot.data() ?? {};
	return {
		id: snapshot.id,
		data: convertValue(rawData)
	};
}
/**
* Recursively convert Firestore-specific types to JSON-serializable values.
*
* Handles: Timestamp, GeoPoint, DocumentReference, Bytes/Buffer,
* nested objects (Maps), and arrays.
*/
function convertValue(value) {
	if (value === null || value === void 0) return value;
	if (isTimestamp(value)) return value.toDate().toISOString();
	if (isGeoPoint(value)) return {
		latitude: value.latitude,
		longitude: value.longitude
	};
	if (isDocumentReference(value)) return value.path;
	if (Buffer.isBuffer(value)) return value.toString("base64");
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	if (Array.isArray(value)) return value.map(convertValue);
	if (typeof value === "object") {
		const result = {};
		for (const [k, v] of Object.entries(value)) result[k] = convertValue(v);
		return result;
	}
	return value;
}
/**
* Type guard for Firestore Timestamp.
*/
function isTimestamp(value) {
	return typeof value === "object" && value !== null && "toDate" in value && typeof value.toDate === "function" && "_seconds" in value;
}
/**
* Type guard for Firestore GeoPoint.
*/
function isGeoPoint(value) {
	return typeof value === "object" && value !== null && "latitude" in value && "longitude" in value && typeof value.latitude === "number" && typeof value.longitude === "number" && value.constructor?.name === "GeoPoint";
}
/**
* Type guard for Firestore DocumentReference.
*/
function isDocumentReference(value) {
	return typeof value === "object" && value !== null && "path" in value && "firestore" in value && value.constructor?.name === "DocumentReference";
}
/**
* Infer field information from raw Firestore DocumentSnapshots.
*
* Must be called BEFORE `documentToData()` conversion so that
* Firestore-specific types (Timestamp, GeoPoint, DocumentReference, Bytes)
* are correctly identified via their native class instances.
*
* @param snapshots - Array of raw Firestore DocumentSnapshots.
* @returns Inferred field information.
*/
function inferFieldsFromSnapshots(snapshots) {
	const fieldTypes = new Map();
	for (const snapshot of snapshots) {
		const rawData = snapshot.data() ?? {};
		for (const [key, value] of Object.entries(rawData)) if (!fieldTypes.has(key) && value !== null && value !== void 0) fieldTypes.set(key, inferType(value));
	}
	return Array.from(fieldTypes.entries()).map(([name, type]) => ({
		name,
		type,
		nullable: true
	}));
}
/**
* Infer the FieldInfo type string for a raw Firestore value.
*
* Checks Firestore-specific types first (Timestamp, GeoPoint, etc.)
* before falling back to primitive type checks.
*/
function inferType(value) {
	if (isTimestamp(value)) return "TIMESTAMP";
	if (isGeoPoint(value)) return "GEOPOINT";
	if (isDocumentReference(value)) return "REFERENCE";
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "BYTES";
	if (typeof value === "string") return "STRING";
	if (typeof value === "number") return "NUMBER";
	if (typeof value === "boolean") return "BOOLEAN";
	if (Array.isArray(value)) return "ARRAY";
	if (typeof value === "object" && value !== null) return "MAP";
	return "STRING";
}
/**
* Map Firebase/Firestore errors to appropriate VenomousError subclasses.
*
* @param err - The original error.
* @param defaultMessage - Fallback message if the error has none.
*/
function wrapError(err, defaultMessage) {
	if (err instanceof ConnectionError || err instanceof AuthenticationError || err instanceof PermissionError || err instanceof QueryError || err instanceof NotFoundError) throw err;
	if (err instanceof Error) {
		const message = err.message || defaultMessage;
		const code = err.code;
		if (code === "unauthenticated") throw new AuthenticationError(`Firestore authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "permission-denied") throw new PermissionError(`Firestore permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "not-found") throw new NotFoundError(`Firestore resource not found: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "unavailable" || code === "deadline-exceeded") throw new ConnectionError(`Firestore connection error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "failed-precondition") throw new QueryError(`Firestore query failed: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "invalid-argument") throw new QueryError(`Firestore invalid argument: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "resource-exhausted") throw new QueryError(`Firestore resource exhausted: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "already-exists") throw new QueryError(`Firestore document already exists: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (code === "cancelled") throw new QueryError(`Firestore operation cancelled: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		const upperMessage = message.toUpperCase();
		if (upperMessage.includes("PERMISSION_DENIED")) throw new PermissionError(`Firestore permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (upperMessage.includes("UNAUTHENTICATED") || upperMessage.includes("CREDENTIAL") || upperMessage.includes("AUTHENTICATION")) throw new AuthenticationError(`Firestore authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (upperMessage.includes("ECONNREFUSED") || upperMessage.includes("ETIMEDOUT") || upperMessage.includes("ENOTFOUND") || upperMessage.includes("UNAVAILABLE")) throw new ConnectionError(`Firestore connection error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`Firestore error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(`Firestore error: ${defaultMessage}`, { connector: CONNECTOR_NAME });
}

//#endregion
//#region src/firestore/index.ts
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
function createFirestoreConnector(options) {
	return new FirestoreConnector(options);
}

//#endregion
export { FirestoreConnector, createFirestoreConnector };
//# sourceMappingURL=index.js.map