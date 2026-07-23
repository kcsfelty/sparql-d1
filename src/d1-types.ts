export type SqlValue =
  null | string | number | bigint | boolean | ArrayBuffer | ArrayBufferView;

export interface SqlResult<T = Record<string, unknown>> {
  results: readonly T[];
  success?: boolean;
  meta?: Readonly<Record<string, unknown>>;
}

export interface SqlStatement {
  bind(...values: readonly SqlValue[]): SqlStatement;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  first?<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch<T = Record<string, unknown>>(
    statements: readonly SqlStatement[],
  ): Promise<readonly SqlResult<T>[]>;
}

export interface SqlCapabilities {
  readonly atomicOrderedBatch: true;
  readonly blobValues: true;
  readonly safeIntegerValues: true;
  readonly bigintValues: boolean;
  readonly first: boolean;
}

const capabilities = new WeakMap<SqlDatabase, SqlCapabilities>();

export function declareSqlCapabilities(
  db: SqlDatabase,
  value: SqlCapabilities,
): void {
  capabilities.set(db, Object.freeze({ ...value }));
}

export function readSqlCapabilities(db: SqlDatabase): SqlCapabilities | null {
  return capabilities.get(db) ?? null;
}

/** Compatibility names retained for structural D1 and SQLite consumers. */
export type D1ResultLike<T = Record<string, unknown>> = SqlResult<T>;
export type D1PreparedStatementLike = SqlStatement;
export type D1DatabaseLike = SqlDatabase;
export type SqliteResultLike<T = Record<string, unknown>> = SqlResult<T>;
export type SqlitePreparedStatementLike = SqlStatement;
export type SqliteDatabaseLike = SqlDatabase;
export type SqliteFirstCapability = Required<Pick<SqlStatement, 'first'>>;
