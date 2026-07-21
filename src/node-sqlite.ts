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

// StatementSync.columns() was backported to the Node 22 line in 22.16.0.
const MINIMUM_NODE_VERSION = [22, 16, 0] as const;

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

class NodeSqliteStatement
  implements SqlitePreparedStatementLike, SqliteFirstCapability
{
  readonly owner: NodeSqliteDatabase;
  readonly sql: string;
  readonly values: readonly SQLInputValue[];

  constructor(
    owner: NodeSqliteDatabase,
    sql: string,
    values: readonly SQLInputValue[] = [],
  ) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): NodeSqliteStatement {
    this.owner.assertOpen();
    return new NodeSqliteStatement(
      this.owner,
      this.sql,
      values.map(normalizeInput),
    );
  }

  async run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.owner.execute(() => this.executeRun<T>());
  }

  async all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>> {
    return this.owner.execute(() => this.executeAll<T>());
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.all<T>();
    return result.results[0] ?? null;
  }

  executeBatch<T>(): SqliteResultLike<T> {
    const statement = this.prepare();
    return statement.columns().length > 0
      ? this.resultForRows<T>(statement)
      : this.resultForChanges<T>(statement);
  }

  private executeRun<T>(): SqliteResultLike<T> {
    return this.resultForChanges<T>(this.prepare());
  }

  private executeAll<T>(): SqliteResultLike<T> {
    return this.resultForRows<T>(this.prepare());
  }

  private prepare(): StatementSync {
    this.owner.assertOpen();
    return this.owner.connection.prepare(this.sql);
  }

  private resultForChanges<T>(statement: StatementSync): SqliteResultLike<T> {
    const result = statement.run(...this.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: result.lastInsertRowid,
      },
    };
  }

  private resultForRows<T>(statement: StatementSync): SqliteResultLike<T> {
    const results = statement.all(...this.values) as T[];
    return {
      results,
      success: true,
      meta: { changes: 0, rows_read: results.length },
    };
  }
}

/**
 * Process-local SQLite adapter backed by Node's synchronous built-in driver.
 * Operations are exposed asynchronously and serialized per connection.
 */
export class NodeSqliteDatabase implements SqliteDatabaseLike {
  readonly connection: DatabaseSync;
  readonly #mutex = new ConnectionMutex();
  #closed = false;

  constructor(path: string, options: NodeSqliteDatabaseOptions = {}) {
    assertSupportedNodeVersion();
    if (!path) {
      throw new TypeError('A SQLite file path or :memory: is required');
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError('busyTimeoutMs must be a non-negative safe integer');
    }

    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec('PRAGMA foreign_keys = ON');
      this.connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      if (path !== ':memory:') {
        this.connection.exec('PRAGMA journal_mode = WAL');
      }
    } catch (cause) {
      this.connection.close();
      this.#closed = true;
      throw cause;
    }
  }

  prepare(sql: string): NodeSqliteStatement {
    this.assertOpen();
    if (!sql.trim()) {
      throw new TypeError('Prepared SQL must not be empty');
    }
    return new NodeSqliteStatement(this, sql);
  }

  async batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>> {
    return this.execute(() => {
      const owned = statements.map((statement) => {
        if (!(statement instanceof NodeSqliteStatement)) {
          throw new TypeError(
            'NodeSqliteDatabase.batch received an incompatible statement',
          );
        }
        if (statement.owner !== this) {
          throw new TypeError(
            'NodeSqliteDatabase.batch received a statement from another connection',
          );
        }
        return statement;
      });

      this.connection.exec('BEGIN IMMEDIATE');
      try {
        const results = owned.map((statement) => statement.executeBatch<T>());
        this.connection.exec('COMMIT');
        return results;
      } catch (cause) {
        try {
          this.connection.exec('ROLLBACK');
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
        this.connection.close();
        this.#closed = true;
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  assertOpen(): void {
    if (this.#closed || !this.connection.isOpen) {
      throw new Error('NodeSqliteDatabase is closed');
    }
  }

  async execute<T>(operation: () => T): Promise<T> {
    return this.#mutex.run(() => {
      this.assertOpen();
      return operation();
    });
  }
}

function normalizeInput(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError(`Unsupported SQLite binding value: ${typeof value}`);
}

function assertSupportedNodeVersion(): void {
  const actual = process.versions.node.split('.').map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const component = actual[index] ?? 0;
    const minimum = MINIMUM_NODE_VERSION[index]!;
    if (component > minimum) {
      return;
    }
    if (component < minimum) {
      throw new Error(
        `@gnolith/diamond/node-sqlite requires Node.js ${MINIMUM_NODE_VERSION.join('.')} or newer`,
      );
    }
  }
}
