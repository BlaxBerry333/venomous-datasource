import { AuthenticationError, ConnectionError, NotFoundError, PermissionError, QueryError, decodeCursor, encodeCursor, validatePageSize } from "../core/index.js";

//#region src/mongodb/auth.ts
const CONNECTOR_NAME$1 = "mongodb";
const DEFAULT_PORT = 27017;
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
async function resolveAuth(auth) {
	try {
		await import("mongodb");
	} catch {
		throw new ConnectionError("mongodb SDK is not installed. Install it with: npm install mongodb", { connector: CONNECTOR_NAME$1 });
	}
	if (!auth) return { uri: `mongodb://localhost:${DEFAULT_PORT}` };
	if (auth.type === "connection-string") {
		if (!auth.connectionString.startsWith("mongodb://") && !auth.connectionString.startsWith("mongodb+srv://")) throw new AuthenticationError("Invalid MongoDB connection string: URI must start with \"mongodb://\" or \"mongodb+srv://\".", { connector: CONNECTOR_NAME$1 });
		return { uri: auth.connectionString };
	}
	if (auth.type === "credentials") {
		const encodedUsername = encodeURIComponent(auth.username);
		const encodedPassword = encodeURIComponent(auth.password);
		const port = auth.port ?? DEFAULT_PORT;
		let uri = `mongodb://${encodedUsername}:${encodedPassword}@${auth.host}:${port}`;
		if (auth.authSource) uri += `/?authSource=${encodeURIComponent(auth.authSource)}`;
		return { uri };
	}
	const _exhaustive = auth;
	throw new Error(`Unknown auth type: ${JSON.stringify(_exhaustive)}`);
}

//#endregion
//#region src/mongodb/connector.ts
const CONNECTOR_NAME = "mongodb";
const DEFAULT_PEEK_ROWS = 10;
const DEFAULT_PAGE_SIZE = 50;
const BATCH_SIZE = 1e3;
const MAX_IN_ELEMENTS = 30;
const DEFAULT_TIMEOUT_MS = 1e4;
/**
* MongoDB connector implementing the `DocumentConnector` interface.
*
* Maps MongoDB's collection/document model to the unified document API.
* Uses the official `mongodb` Node.js driver (v6+).
*
* @example
* ```typescript
* import { createMongoDBConnector } from 'venomous-datasource/mongodb';
*
* const connector = createMongoDBConnector({ database: 'mydb' });
* await connector.connect();
*
* const collections = await connector.collections();
* const preview = await connector.peek('users', { rows: 5 });
* const doc = await connector.getById('users', '507f1f77bcf86cd799439011');
*
* await connector.disconnect();
* ```
*/
var MongoDBConnector = class {
	options;
	client = null;
	db = null;
	connected = false;
	schemaCache = new Map();
	constructor(options) {
		this.options = options;
	}
	/**
	* Connect to MongoDB and initialize the client.
	* Idempotent: if already connected, disconnects first then reconnects.
	*
	* @param auth - Authentication configuration. When omitted, connects to localhost:27017.
	* @throws {ConnectionError} When mongodb SDK is not installed or connection fails.
	* @throws {AuthenticationError} When credentials are invalid.
	*/
	async connect(auth) {
		if (this.connected) await this.disconnect();
		const resolved = await resolveAuth(auth);
		const { MongoClient: MongoClientClass } = await import("mongodb");
		const connectTimeoutMS = this.options.connectTimeoutMS ?? DEFAULT_TIMEOUT_MS;
		const serverSelectionTimeoutMS = this.options.serverSelectionTimeoutMS ?? DEFAULT_TIMEOUT_MS;
		let client = null;
		try {
			client = new MongoClientClass(resolved.uri, {
				connectTimeoutMS,
				serverSelectionTimeoutMS
			});
			await client.connect();
			const db = client.db(this.options.database);
			await db.command({ ping: 1 });
			this.client = client;
			this.db = db;
			this.connected = true;
		} catch (err) {
			if (client) try {
				await client.close();
			} catch {}
			throw wrapError(err, "Failed to connect to MongoDB");
		}
	}
	/**
	* Disconnect from MongoDB and release all resources.
	* Idempotent: calling on an already-disconnected connector is a no-op.
	*/
	async disconnect() {
		this.schemaCache.clear();
		if (this.client) {
			try {
				await this.client.close();
			} catch {}
			this.client = null;
		}
		this.db = null;
		this.connected = false;
	}
	/**
	* List all collections in the database.
	* Filters out `system.*` collections and views.
	*
	* @returns Array of collection metadata (name only).
	*/
	async collections() {
		this.ensureConnected();
		try {
			const items = await this.db.listCollections().toArray();
			return items.filter((item) => item.type === "collection" && !item.name.startsWith("system.")).map((item) => ({ name: item.name }));
		} catch (err) {
			throw wrapError(err, "Failed to list collections");
		}
	}
	/**
	* Preview the first N documents of a collection and infer field information.
	*
	* @param collection - Collection name.
	* @param options - Preview options (default: 10 documents).
	* @returns Preview result with documents and optional inferred field info.
	*/
	async peek(collection, options) {
		this.ensureConnected();
		const rows = options?.rows ?? DEFAULT_PEEK_ROWS;
		const limit = Math.max(1, Math.min(rows, 1e3));
		try {
			const col = this.db.collection(collection);
			const docs = await col.find().limit(limit).toArray();
			if (docs.length === 0) return { data: [] };
			const fields = this.schemaCache.get(collection) ?? inferFieldsFromDocuments(docs);
			const documents = docs.map((doc) => documentToData(doc));
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
	* Uses cursor-based pagination. When no `orderBy` is specified, paginates
	* by `_id`. When custom `orderBy` is specified, uses a compound sort
	* with `_id` as tiebreaker and `$or` conditions for cursor positioning.
	*
	* @param collection - Collection name.
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
			const col = this.db.collection(collection);
			let mongoFilter = buildMongoFilter(filter);
			const mongoSort = buildMongoSort(orderBy);
			if (cursor) {
				const cursorState = decodeCursor(cursor);
				const cursorFilter = await buildCursorFilter(cursorState, orderBy);
				if (Object.keys(mongoFilter).length > 0) mongoFilter = { $and: [mongoFilter, cursorFilter] };
				else mongoFilter = cursorFilter;
			}
			const docs = await col.find(mongoFilter).sort(mongoSort).limit(pageSize + 1).toArray();
			const hasMore = docs.length > pageSize;
			const resultDocs = hasMore ? docs.slice(0, pageSize) : docs;
			const data = resultDocs.map((doc) => documentToData(doc));
			let nextCursor;
			if (hasMore && resultDocs.length > 0) {
				const lastDoc = resultDocs[resultDocs.length - 1];
				nextCursor = buildNextCursor(lastDoc, orderBy);
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
	* Attempts to match both ObjectId and string forms of the ID
	* when the ID is a valid 24-character hexadecimal string.
	*
	* @param collection - Collection name.
	* @param id - Document ID (must not be empty or contain `/`).
	* @returns The document, or `null` if it does not exist.
	* @throws {QueryError} When the ID is invalid.
	*/
	async getById(collection, id) {
		this.ensureConnected();
		validateDocumentId(id);
		try {
			const col = this.db.collection(collection);
			let doc;
			if (isObjectIdHex(id)) {
				const { ObjectId } = await import("mongodb");
				doc = await col.findOne({ $or: [{ _id: new ObjectId(id) }, { _id: id }] });
			} else doc = await col.findOne({ _id: id });
			if (!doc) return null;
			return documentToData(doc);
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to get document "${id}" from "${collection}"`);
		}
	}
	/**
	* Insert documents into a collection.
	*
	* Uses `insertMany` with `ordered: false` (best-effort insertion).
	* Large batches are split into chunks of 1000. Multi-batch operations
	* are NOT atomic -- if a later batch fails, earlier batches are not rolled back.
	*
	* @param collection - Collection name.
	* @param docs - Array of documents to insert.
	* @returns Insert result with count and actual IDs used.
	* @throws {QueryError} When a document ID is invalid or a duplicate key is encountered.
	*/
	async insert(collection, docs) {
		this.ensureConnected();
		if (docs.length === 0) return {
			insertedCount: 0,
			insertedIds: []
		};
		for (const doc of docs) if (doc.id !== void 0) validateDocumentId(doc.id);
		const col = this.db.collection(collection);
		const insertedIds = [];
		try {
			for (let i = 0; i < docs.length; i += BATCH_SIZE) {
				const batchDocs = docs.slice(i, i + BATCH_SIZE);
				const { ObjectId } = await import("mongodb");
				const mongoDocs = [];
				for (const doc of batchDocs) {
					const mongoDoc = { ...doc.data };
					if (doc.id !== void 0) mongoDoc["_id"] = isObjectIdHex(doc.id) ? new ObjectId(doc.id) : doc.id;
					mongoDocs.push(mongoDoc);
				}
				const result = await col.insertMany(mongoDocs, { ordered: false });
				for (let j = 0; j < mongoDocs.length; j++) {
					const insertedId = result.insertedIds[j];
					insertedIds.push(String(insertedId));
				}
			}
			return {
				insertedCount: insertedIds.length,
				insertedIds
			};
		} catch (err) {
			const context = `(${insertedIds.length} of ${docs.length} inserted before failure)`;
			const fallbackMessage = `Failed to insert documents into "${collection}" ${context}`;
			if (err instanceof Error && err.message) err.message = `${err.message} ${context}`;
			throw wrapError(err, fallbackMessage);
		}
	}
	/**
	* Update documents matching a filter.
	*
	* Uses MongoDB's native `updateMany` with `$set` semantics (partial update,
	* does not replace the entire document).
	*
	* @param collection - Collection name.
	* @param options - Update options with filter and set values.
	* @returns Update result with count.
	* @throws {QueryError} When the filter is empty.
	*/
	async update(collection, options) {
		this.ensureConnected();
		validateNonEmptyFilter(options.filter);
		try {
			const col = this.db.collection(collection);
			const mongoFilter = buildMongoFilter(options.filter);
			const result = await col.updateMany(mongoFilter, { $set: options.set });
			return { updatedCount: result.modifiedCount };
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to update documents in "${collection}"`);
		}
	}
	/**
	* Delete documents matching a filter.
	*
	* Uses MongoDB's native `deleteMany`.
	*
	* @param collection - Collection name.
	* @param options - Remove options with filter.
	* @returns Delete result with count.
	* @throws {QueryError} When the filter is empty.
	*/
	async remove(collection, options) {
		this.ensureConnected();
		validateNonEmptyFilter(options.filter);
		try {
			const col = this.db.collection(collection);
			const mongoFilter = buildMongoFilter(options.filter);
			const result = await col.deleteMany(mongoFilter);
			return { deletedCount: result.deletedCount };
		} catch (err) {
			if (err instanceof QueryError) throw err;
			throw wrapError(err, `Failed to delete documents from "${collection}"`);
		}
	}
	/**
	* Ensure the connector is connected. Throws if not.
	*/
	ensureConnected() {
		if (!this.connected || !this.db) throw new ConnectionError("Not connected to MongoDB. Call connect() first.", {
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
* Check if a string is a valid ObjectId hex (24 hex characters).
*/
function isObjectIdHex(id) {
	return /^[0-9a-fA-F]{24}$/.test(id);
}
/**
* Convert a MongoDB document to a `Document` with `_id` mapped to `id`.
*
* @param doc - Raw MongoDB document.
* @returns Converted Document with id and data.
*/
function documentToData(doc) {
	const { _id,...data } = doc;
	return {
		id: idToString(_id),
		data
	};
}
/**
* Convert any `_id` value to a string representation.
*/
function idToString(id) {
	if (id === null || id === void 0) return "";
	if (typeof id === "object" && id !== null && "toHexString" in id) return id.toHexString();
	return String(id);
}
/**
* Infer field information from raw MongoDB documents.
*
* For each field, the type is determined by the first non-null/undefined value
* encountered across all sampled documents. When the same field has different
* types in different documents (common in schema-less databases), only the
* first observed type is reported. This is a known limitation consistent with
* the Firestore connector's `inferFieldsFromSnapshots` behavior.
*
* @param docs - Array of MongoDB documents.
* @returns Inferred field information.
*/
function inferFieldsFromDocuments(docs) {
	const fieldTypes = new Map();
	for (const doc of docs) for (const [key, value] of Object.entries(doc)) {
		if (key === "_id") continue;
		if (!fieldTypes.has(key) && value !== null && value !== void 0) fieldTypes.set(key, inferType(value));
	}
	return Array.from(fieldTypes.entries()).map(([name, type]) => ({
		name,
		type,
		nullable: true
	}));
}
/**
* Infer the FieldInfo type string for a MongoDB value.
*/
function inferType(value) {
	if (typeof value === "string") return "STRING";
	if (typeof value === "number") return "NUMBER";
	if (typeof value === "boolean") return "BOOLEAN";
	if (value instanceof Date) return "DATE";
	if (typeof value === "object" && value !== null && "toHexString" in value && value.constructor?.name === "ObjectId") return "OBJECTID";
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "BINARY";
	if (typeof value === "object" && value !== null && value.constructor?.name === "Binary") return "BINARY";
	if (Array.isArray(value)) return "ARRAY";
	if (typeof value === "object" && value !== null) return "OBJECT";
	return "STRING";
}
/**
* Build a MongoDB filter object from DocFilter conditions.
* Multiple conditions on the same field use `$and`.
*
* @param filter - DocFilter conditions (AND combined).
* @returns MongoDB filter object.
*/
function buildMongoFilter(filter) {
	if (!filter || filter.length === 0) return {};
	const fieldConditions = new Map();
	for (const condition of filter) {
		validateFilterCondition(condition);
		const mongoCondition = toMongoCondition(condition);
		const existing = fieldConditions.get(condition.field);
		if (existing) existing.push(mongoCondition);
		else fieldConditions.set(condition.field, [mongoCondition]);
	}
	let hasMultiConditionField = false;
	for (const [, conditions] of fieldConditions) if (conditions.length > 1) {
		hasMultiConditionField = true;
		break;
	}
	if (!hasMultiConditionField) {
		const result = {};
		for (const [, conditions] of fieldConditions) {
			const cond = conditions[0];
			Object.assign(result, cond);
		}
		return result;
	}
	const andConditions = [];
	for (const [, conditions] of fieldConditions) for (const cond of conditions) andConditions.push(cond);
	return { $and: andConditions };
}
/**
* Validate a single filter condition.
*/
function validateFilterCondition(condition) {
	const validOps = [
		"eq",
		"ne",
		"gt",
		"lt",
		"gte",
		"lte",
		"in"
	];
	if (!validOps.includes(condition.operator)) throw new QueryError(`Unsupported filter operator: "${condition.operator}"`, {
		code: "VENOMOUS_INVALID_QUERY",
		connector: CONNECTOR_NAME
	});
	if (condition.operator === "in") {
		if (!Array.isArray(condition.value)) throw new QueryError("\"in\" operator requires an array value.", {
			code: "VENOMOUS_INVALID_QUERY",
			connector: CONNECTOR_NAME
		});
		if (condition.value.length > MAX_IN_ELEMENTS) throw new QueryError(`"in" operator supports a maximum of ${MAX_IN_ELEMENTS} elements. Got: ${condition.value.length}`, {
			code: "VENOMOUS_INVALID_QUERY",
			connector: CONNECTOR_NAME
		});
	}
}
/**
* Convert a single DocFilterCondition to a MongoDB filter fragment.
*/
function toMongoCondition(condition) {
	const { field, operator, value } = condition;
	switch (operator) {
		case "eq": return { [field]: value };
		case "ne": return { [field]: { $ne: value } };
		case "gt": return { [field]: { $gt: value } };
		case "lt": return { [field]: { $lt: value } };
		case "gte": return { [field]: { $gte: value } };
		case "lte": return { [field]: { $lte: value } };
		case "in": return { [field]: { $in: value } };
		default: {
			const _exhaustive = operator;
			throw new QueryError(`Unsupported filter operator: "${String(_exhaustive)}"`, {
				code: "VENOMOUS_INVALID_QUERY",
				connector: CONNECTOR_NAME
			});
		}
	}
}
/**
* Build a MongoDB sort object from DocOrderByClause array.
* Always appends `_id` as the tiebreaker for stable pagination.
*/
function buildMongoSort(orderBy) {
	const sort = {};
	if (orderBy && orderBy.length > 0) for (const clause of orderBy) sort[clause.field] = clause.direction === "asc" ? 1 : -1;
	if (!sort["_id"]) sort["_id"] = 1;
	return sort;
}
/**
* Tag a value for cursor serialization, preserving type information.
*/
function tagCursorValue(value) {
	if (value === null || value === void 0) return {
		t: "null",
		v: ""
	};
	if (value instanceof Date) return {
		t: "date",
		v: value.toISOString()
	};
	if (typeof value === "object" && value !== null && "toHexString" in value) return {
		t: "objectid",
		v: value.toHexString()
	};
	if (typeof value === "number") return {
		t: "number",
		v: String(value)
	};
	if (typeof value === "boolean") return {
		t: "boolean",
		v: String(value)
	};
	return {
		t: "string",
		v: String(value)
	};
}
/**
* Restore a tagged cursor value to its original typed form.
*/
async function untagCursorValue(tagged) {
	switch (tagged.t) {
		case "null": return null;
		case "date": return new Date(tagged.v);
		case "objectid": {
			const { ObjectId } = await import("mongodb");
			return new ObjectId(tagged.v);
		}
		case "number": return Number(tagged.v);
		case "boolean": return tagged.v === "true";
		case "string": return tagged.v;
		default: return tagged.v;
	}
}
/**
* Build the next cursor from the last document in a result set.
*/
function buildNextCursor(lastDoc, orderBy) {
	const cursorData = { lastId: tagCursorValue(lastDoc["_id"]) };
	if (orderBy && orderBy.length > 0) {
		const lastSortValues = orderBy.map((clause) => tagCursorValue(lastDoc[clause.field]));
		cursorData["lastSortValues"] = lastSortValues;
	}
	return encodeCursor(cursorData);
}
/**
* Build a cursor filter for pagination using `$or` conditions.
*
* For simple pagination (no orderBy): `{ _id: { $gt: lastId } }`
*
* For compound pagination (with orderBy), uses recursive `$or`:
* ```
* { $or: [
*   { field1: { $gt: lastVal1 } },                           // strict on field1
*   { field1: lastVal1, field2: { $gt: lastVal2 } },        // equal on field1, strict on field2
*   { field1: lastVal1, field2: lastVal2, _id: { $gt: lastId } }  // equal on all, strict on _id
* ] }
* ```
* `desc` fields use `$lt` instead of `$gt`.
*/
async function buildCursorFilter(cursorState, orderBy) {
	const lastIdTagged = cursorState["lastId"];
	if (!lastIdTagged || typeof lastIdTagged !== "object") throw new QueryError("Invalid cursor: missing lastId", {
		code: "VENOMOUS_INVALID_CURSOR",
		connector: CONNECTOR_NAME
	});
	const lastId = await untagCursorValue(lastIdTagged);
	if (!orderBy || orderBy.length === 0) return { _id: { $gt: lastId } };
	const lastSortValues = cursorState["lastSortValues"];
	if (!lastSortValues || !Array.isArray(lastSortValues)) throw new QueryError("Invalid cursor: missing lastSortValues", {
		code: "VENOMOUS_INVALID_CURSOR",
		connector: CONNECTOR_NAME
	});
	if (lastSortValues.length !== orderBy.length) throw new QueryError("Invalid cursor: lastSortValues length mismatch", {
		code: "VENOMOUS_INVALID_CURSOR",
		connector: CONNECTOR_NAME
	});
	const restoredValues = [];
	for (const tagged of lastSortValues) restoredValues.push(await untagCursorValue(tagged));
	const orConditions = [];
	for (let i = 0; i < orderBy.length; i++) {
		const condition = {};
		for (let j = 0; j < i; j++) condition[orderBy[j].field] = restoredValues[j];
		const direction = orderBy[i].direction;
		const op = direction === "asc" ? "$gt" : "$lt";
		condition[orderBy[i].field] = { [op]: restoredValues[i] };
		orConditions.push(condition);
	}
	const tiebreaker = {};
	for (let j = 0; j < orderBy.length; j++) tiebreaker[orderBy[j].field] = restoredValues[j];
	tiebreaker["_id"] = { $gt: lastId };
	orConditions.push(tiebreaker);
	return { $or: orConditions };
}
/**
* Sanitize a URI in an error message by redacting the password portion.
* Handles both `mongodb://user:pass@host` and `mongodb+srv://user:pass@host` formats.
*/
function redactUriInMessage(message) {
	return message.replace(/mongodb(\+srv)?:\/\/[^@]*@/g, "mongodb$1://[REDACTED]@");
}
/**
* Map MongoDB errors to appropriate VenomousError subclasses.
*
* @param err - The original error.
* @param defaultMessage - Fallback message if the error has none.
*/
function wrapError(err, defaultMessage) {
	if (err instanceof ConnectionError || err instanceof AuthenticationError || err instanceof PermissionError || err instanceof QueryError || err instanceof NotFoundError) throw err;
	if (err instanceof Error) {
		const rawMessage = err.message || defaultMessage;
		const message = redactUriInMessage(rawMessage);
		const code = err.code;
		const errName = err.constructor?.name ?? "";
		if (typeof code === "number") {
			if (code === 18) throw new AuthenticationError(`MongoDB authentication failed: ${message}`, {
				cause: err,
				connector: CONNECTOR_NAME
			});
			if (code === 13) throw new PermissionError(`MongoDB permission denied: ${message}`, {
				cause: err,
				connector: CONNECTOR_NAME
			});
			if (code === 11e3) throw new QueryError(`MongoDB duplicate key: ${message}`, {
				code: "VENOMOUS_DUPLICATE_KEY",
				cause: err,
				connector: CONNECTOR_NAME
			});
			if (code === 26) throw new NotFoundError(`MongoDB namespace not found: ${message}`, {
				cause: err,
				connector: CONNECTOR_NAME
			});
		}
		if (errName === "MongoNetworkError" || errName === "MongoNetworkTimeoutError") throw new ConnectionError(`MongoDB network error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errName === "MongoServerSelectionError") throw new ConnectionError(`MongoDB server selection failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errName === "MongoInvalidArgumentError") throw new QueryError(`MongoDB invalid argument: ${message}`, {
			code: "VENOMOUS_INVALID_QUERY",
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (errName === "MongoBulkWriteError") {
			const writeErrors = err.writeErrors;
			const isDuplicateKey = typeof code === "number" && code === 11e3 || writeErrors?.some((we) => we.code === 11e3);
			if (isDuplicateKey) throw new QueryError(`MongoDB duplicate key: ${message}`, {
				code: "VENOMOUS_DUPLICATE_KEY",
				cause: err,
				connector: CONNECTOR_NAME
			});
		}
		const upperMessage = message.toUpperCase();
		if (upperMessage.includes("ECONNREFUSED") || upperMessage.includes("ETIMEDOUT") || upperMessage.includes("ENOTFOUND")) throw new ConnectionError(`MongoDB connection error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (upperMessage.includes("AUTHENTICATION") || upperMessage.includes("CREDENTIAL")) throw new AuthenticationError(`MongoDB authentication failed: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		if (upperMessage.includes("NOT AUTHORIZED") || upperMessage.includes("UNAUTHORIZED")) throw new PermissionError(`MongoDB permission denied: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
		throw new QueryError(`MongoDB error: ${message}`, {
			cause: err,
			connector: CONNECTOR_NAME
		});
	}
	throw new QueryError(`MongoDB error: ${defaultMessage}`, { connector: CONNECTOR_NAME });
}

//#endregion
//#region src/mongodb/index.ts
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
* await connector.connect();
*
* const collections = await connector.collections();
* const preview = await connector.peek('users', { rows: 5 });
*
* await connector.disconnect();
* ```
*/
function createMongoDBConnector(options) {
	return new MongoDBConnector(options);
}

//#endregion
export { MongoDBConnector, createMongoDBConnector };
//# sourceMappingURL=index.js.map