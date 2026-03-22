export type {
  BaseAuth,
  BigQueryAuth,
  S3Auth,
  GCSAuth,
  SheetsAuth,
  AzureBlobAuth,
  TabularAuth,
  FileAuth,
} from './auth.js';

export type { PageOptions, PageResult } from './pagination.js';

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
} from './query.js';

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
} from './result.js';
