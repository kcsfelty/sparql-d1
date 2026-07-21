export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
}

/**
 * Runtime-neutral SQLite result shape used by Diamond storage adapters.
 * Batch implementations return these results in statement input order.
 */
export interface SqliteResultLike<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

/** The minimum prepared-statement capability required by Diamond. */
export interface SqlitePreparedStatementLike {
  bind(...values: unknown[]): SqlitePreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
}

/**
 * The minimum asynchronous SQLite capability used by Diamond.
 * `batch` is expected to execute atomically and return positional results.
 */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqlitePreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>>;
}

/** Optional row convenience supported by adapters that expose `first()`. */
export interface SqliteFirstCapability {
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
