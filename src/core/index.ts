// Interfaces
export type { TabularConnector } from './interfaces/tabular-connector.js';
export type { FileConnector } from './interfaces/file-connector.js';
export type { DocumentConnector } from './interfaces/document-connector.js';

// Types
export type {
  BaseAuth,
  BigQueryAuth,
  S3Auth,
  GCSAuth,
  SheetsAuth,
  AzureBlobAuth,
  FirestoreAuth,
  TabularAuth,
  FileAuth,
  DocumentAuth,
} from './types/auth.js';

export type { PageOptions, PageResult } from './types/pagination.js';

export type {
  WhereOperator,
  WhereCondition,
  WhereClause,
  OrderDirection,
  OrderByClause,
  FindOptions,
  PeekOptions,
  ListOptions,
  UpdateOptions,
  WhereOptions,
} from './types/query.js';

export type {
  Row,
  ColumnInfo,
  TableInfo,
  FileInfo,
  PeekResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  WriteResult,
} from './types/result.js';

export type {
  Document,
  DocumentInput,
  CollectionInfo,
  FieldInfo,
  DocFilterOperator,
  DocFilterCondition,
  DocFilter,
  DocOrderByClause,
  DocFindOptions,
  DocPeekOptions,
  DocPeekResult,
  DocInsertResult,
  DocUpdateResult,
  DocDeleteResult,
  DocUpdateOptions,
  DocRemoveOptions,
} from './types/document.js';

// Error classes
export { VenomousError } from './errors/base.js';
export { AuthenticationError } from './errors/auth.js';
export { ConnectionError } from './errors/connection.js';
export { QueryError } from './errors/query.js';
export { PathError } from './errors/path.js';
export { NotFoundError } from './errors/not-found.js';
export { PermissionError } from './errors/permission.js';

// Utility functions
export { normalizePath, isPathSafe, encodeCJK } from './utils/path.js';
export { redactAuth, sanitizeError } from './utils/sanitize.js';
export { validatePageSize, encodeCursor, decodeCursor } from './utils/pagination.js';
export { parseCsv, parseJson, getFileFormat } from './utils/parsers.js';
