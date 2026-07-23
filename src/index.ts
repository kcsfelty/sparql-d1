export type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  SqliteDatabaseLike,
  SqliteFirstCapability,
  SqlitePreparedStatementLike,
  SqliteResultLike,
  SqlCapabilities,
  SqlDatabase,
  SqlResult,
  SqlStatement,
  SqlValue,
} from './d1-types.js';
export { declareSqlCapabilities, readSqlCapabilities } from './d1-types.js';
export {
  D1QuadSource,
  D1QuadSource as SqliteQuadSource,
  D1QuadStore,
  D1QuadStore as SqliteQuadStore,
  QuadPatchConflictError,
  applyQuadPatch,
  prepareQuadPatch,
  statementsForQuadPatch,
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
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  registerMigrationLedgerOwnerV1,
} from './migrations.js';
export type {
  AppliedMigration,
  MigrationAssemblyAuthority,
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
  MigrationLedgerSliceEntry,
  NamespacedMigration,
} from './migrations.js';
export { decodeTerm, encodeTerm } from './term-codec.js';
export type { StoredTerm } from './term-codec.js';
export {
  MAX_PORTABLE_SQLITE_BIND_BYTES,
  assertSqlitePayloadSize,
  readSqliteBytes,
  sqlitePayloadByteLength,
} from './sqlite-values.js';
export type { SqlitePayload } from './sqlite-values.js';
