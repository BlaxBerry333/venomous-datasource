export type {
  BigQueryAuth,
  GoogleCloudStorageAuth,
  SheetsAuth,
  FirestoreAuth,
  AWSS3Auth,
  AzureBlobStorageAuth,
  MongoDBAuth,
  TabularAuth,
  FileAuth,
  DocumentAuth,
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
} from './document.js';
