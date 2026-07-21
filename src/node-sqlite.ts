import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import type {
  SqliteDatabaseLike,
  SqliteFirstCapability,
  SqlitePreparedStatementLike,
  SqliteResultLike,
} from './d1-types.js';
import { assertSupportedNodeSqliteVersion } from './node-version.js';

export interface NodeSqliteDatabaseOptions {
  /** How long SQLite waits for a conflicting file lock. Defaults to 5 seconds. */
  busyTimeoutMs?: number;
}

class ConnectionMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

type ConnectionOperation = <T>(
  operation: (connection: DatabaseSync) => T,
) => Promise<T>;

class NodeSqliteStatement
  implements SqlitePreparedStatementLike, SqliteFirstCapability
{
  readonly #owner: object;
  readonly #sql: string;
  readonly #values: readonly SQLInputValue[];
  readonly #withConnection: ConnectionOperation;

  constructor(
    owner: object,
    sql: string,
    withConnection: ConnectionOperation,
    values: readonly SQLInputValue[] = [],
  ) {
    this.#owner = owner;
    this.#sql = sql;
    this.#withConnection = withConnection;
    this.#values = values;
  }

  bind(...values: unknown[]): NodeSqliteStatement {
    return new NodeSqliteStatement(
      this.#owner,
      this.#sql,
      this.#withConnection,
      values.map(normalizeInput),
    );
  }

  async run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.#withConnection((connection) =>
      this.#executeRun<T>(connection),
    );
  }

  async all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.#withConnection((connection) =>
      this.#executeAll<T>(connection),
    );
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.all<T>();
    return result.results[0] ?? null;
  }

  belongsTo(owner: object): boolean {
    return this.#owner === owner;
  }

  executeBatch<T>(connection: DatabaseSync): SqliteResultLike<T> {
    const statement = connection.prepare(this.#sql);
    return statement.columns().length > 0
      ? this.#resultForRows<T>(connection, statement)
      : this.#resultForChanges<T>(statement);
  }

  #executeRun<T>(connection: DatabaseSync): SqliteResultLike<T> {
    return this.#resultForChanges<T>(connection.prepare(this.#sql));
  }

  #executeAll<T>(connection: DatabaseSync): SqliteResultLike<T> {
    return this.#resultForRows<T>(connection, connection.prepare(this.#sql));
  }

  #resultForChanges<T>(statement: StatementSync): SqliteResultLike<T> {
    const result = statement.run(...this.#values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: result.lastInsertRowid,
      },
    };
  }

  #resultForRows<T>(
    connection: DatabaseSync,
    statement: StatementSync,
  ): SqliteResultLike<T> {
    const before = readTotalChanges(connection);
    const results = statement.all(...this.#values) as T[];
    const changes = readTotalChanges(connection) - before;
    return {
      results,
      success: true,
      meta: { changes, rows_read: results.length },
    };
  }
}

/**
 * Process-local SQLite adapter backed by Node's synchronous built-in driver.
 * Operations are exposed asynchronously and serialized per connection.
 */
export class NodeSqliteDatabase implements SqliteDatabaseLike {
  readonly #connection: DatabaseSync;
  readonly #mutex = new ConnectionMutex();
  readonly #owner = {};
  #closed = false;

  constructor(path: string, options: NodeSqliteDatabaseOptions = {}) {
    assertSupportedNodeSqliteVersion(process.versions.node);
    if (!path) {
      throw new TypeError('A SQLite file path or :memory: is required');
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError('busyTimeoutMs must be a non-negative safe integer');
    }

    this.#connection = new DatabaseSync(path);
    try {
      this.#connection.exec('PRAGMA foreign_keys = ON');
      this.#connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      if (path !== ':memory:') {
        this.#connection.exec('PRAGMA journal_mode = WAL');
      }
    } catch (cause) {
      this.#connection.close();
      this.#closed = true;
      throw cause;
    }
  }

  prepare(sql: string): SqlitePreparedStatementLike & SqliteFirstCapability {
    this.#assertOpen();
    if (!sql.trim()) {
      throw new TypeError('Prepared SQL must not be empty');
    }
    return new NodeSqliteStatement(
      this.#owner,
      sql,
      this.#withConnection.bind(this),
    );
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>> {
    return this.#withConnection((connection) => {
      const owned = statements.map((statement) => {
        if (!(statement instanceof NodeSqliteStatement)) {
          throw new TypeError(
            'NodeSqliteDatabase.batch received an incompatible statement',
          );
        }
        if (!statement.belongsTo(this.#owner)) {
          throw new TypeError(
            'NodeSqliteDatabase.batch received a statement from another connection',
          );
        }
        return statement;
      });

      connection.exec('BEGIN IMMEDIATE');
      try {
        const results = owned.map((statement) =>
          statement.executeBatch<T>(connection),
        );
        connection.exec('COMMIT');
        return results;
      } catch (cause) {
        try {
          connection.exec('ROLLBACK');
        } catch {
          // Preserve the statement/commit failure that caused the rollback.
        }
        throw cause;
      }
    });
  }

  async close(): Promise<void> {
    await this.#mutex.run(() => {
      if (!this.#closed) {
        this.#connection.close();
        this.#closed = true;
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #withConnection<T>(
    operation: (connection: DatabaseSync) => T,
  ): Promise<T> {
    return this.#mutex.run(() => {
      this.#assertOpen();
      return operation(this.#connection);
    });
  }

  #assertOpen(): void {
    if (this.#closed || !this.#connection.isOpen) {
      throw new Error('NodeSqliteDatabase is closed');
    }
  }
}

function normalizeInput(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }
  throw new TypeError(`Unsupported SQLite binding value: ${typeof value}`);
}

function readTotalChanges(connection: DatabaseSync): number {
  const row = connection.prepare('SELECT total_changes() AS changes').get() as {
    changes: number | bigint;
  };
  return Number(row.changes);
}
