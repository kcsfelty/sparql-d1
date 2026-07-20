import Database from 'better-sqlite3';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../src/d1-types.js';

class MemoryStatement implements D1PreparedStatementLike {
  readonly #database: Database.Database;
  readonly #sql: string;
  readonly #values: unknown[];

  constructor(
    database: Database.Database,
    sql: string,
    values: unknown[] = [],
  ) {
    this.#database = database;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new MemoryStatement(this.#database, this.#sql, values);
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const info = this.#database.prepare(this.#sql).run(...this.#values);
    return {
      results: [],
      success: true,
      meta: { changes: info.changes },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const results = this.#database
      .prepare(this.#sql)
      .all(...this.#values) as T[];
    return {
      results,
      success: true,
      meta: { changes: 0, rows_read: results.length },
    };
  }

  execute(): D1ResultLike {
    const statement = this.#database.prepare(this.#sql);
    if (statement.reader) {
      return {
        results: statement.all(...this.#values) as Record<string, unknown>[],
        success: true,
        meta: { changes: 0 },
      };
    }
    const info = statement.run(...this.#values);
    return { results: [], success: true, meta: { changes: info.changes } };
  }
}

export class MemoryD1 implements D1DatabaseLike {
  readonly database = new Database(':memory:');

  prepare(sql: string): D1PreparedStatementLike {
    return new MemoryStatement(this.database, sql);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>> {
    const execute = this.database.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof MemoryStatement)) {
          throw new TypeError('MemoryD1 received an incompatible statement');
        }
        return statement.execute() as D1ResultLike<T>;
      }),
    );
    return execute();
  }

  close(): void {
    this.database.close();
  }
}
