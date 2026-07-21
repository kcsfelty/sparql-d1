import {
  D1QuadSource,
  D1QuadStore,
  SqliteQuadSource,
  SqliteQuadStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type SqliteDatabaseLike,
  type SqlitePreparedStatementLike,
  type SqliteResultLike,
  readSqliteBytes,
} from '../src/index.js';

declare const legacyDb: D1DatabaseLike;
const legacyStatement: D1PreparedStatementLike = legacyDb.prepare('SELECT 1');
const legacyResult: Promise<D1ResultLike> = legacyStatement.all();
new D1QuadSource(legacyDb);
new D1QuadStore(legacyDb);
void legacyResult;

declare const neutralDb: SqliteDatabaseLike;
const neutralStatement: SqlitePreparedStatementLike =
  neutralDb.prepare('SELECT 1');
const neutralResult: Promise<SqliteResultLike> = neutralStatement.all();
new SqliteQuadSource(neutralDb);
new SqliteQuadStore(neutralDb);
void neutralResult;

// Structural compatibility is deliberate in both directions.
const d1AsNeutral: SqliteDatabaseLike = legacyDb;
const neutralAsD1: D1DatabaseLike = neutralDb;
void d1AsNeutral;
void neutralAsD1;

const portableBytes: Uint8Array = readSqliteBytes([0, 127, 255]);
void portableBytes;
