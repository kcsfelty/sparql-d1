export type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  SqliteDatabaseLike,
  SqliteFirstCapability,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from './d1-types.js';
export {
  D1QuadSource,
  D1QuadSource as SqliteQuadSource,
  D1QuadStore,
  D1QuadStore as SqliteQuadStore,
  QuadPatchConflictError,
  applyQuadPatch,
  prepareQuadPatch,
  deleteQuads,
  deleteMatchingQuads,
  insertQuads,
} from './d1-source.js';
export type {
  D1QuadSourceOptions,
  D1QuadSourceOptions as SqliteQuadSourceOptions,
  QuadPatch,
  QuadPatchResult,
  PreparedQuadPatch,
  QueryObservation,
} from './d1-source.js';
export {
  diamondMigrationNamespace,
  diamondMigrations,
  expectedStoreIndexes,
  initializeStore,
  inspectStoreSchema,
  migrateDiamondStore,
  schemaStatements,
} from './schema.js';
export type { StoreSchemaInspection } from './schema.js';
export {
  MigrationStateError,
  applyNamespacedMigrations,
  checksumMigration,
  ensureMigrationLedger,
  migrationLedgerTable,
  readAppliedMigrations,
  recordMigrationAdoption,
} from './migrations.js';
export type { AppliedMigration, NamespacedMigration } from './migrations.js';
export { decodeTerm, encodeTerm } from './term-codec.js';
export type { StoredTerm } from './term-codec.js';
export {
  MAX_PORTABLE_SQLITE_BIND_BYTES,
  assertSqlitePayloadSize,
  readSqliteBytes,
  sqlitePayloadByteLength,
} from './sqlite-values.js';
export type { SqlitePayload } from './sqlite-values.js';
export { allowServiceUrls, createSparqlHandler } from './endpoint.js';
export type {
  D1SourceFactory,
  D1SourceFactoryOptions,
  ServicePolicy,
  SparqlHandlerOptions,
  SparqlRequestObservation,
} from './endpoint.js';
