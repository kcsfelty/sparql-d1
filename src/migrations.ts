import type { SqliteDatabaseLike } from './d1-types.js';

export const migrationLedgerTable = '_gnolith_migrations' as const;

export interface NamespacedMigration {
  /** Stable, monotonically ordered identifier within one namespace. */
  id: string;
  /** Single SQLite statements applied in array order. */
  statements: readonly string[];
}

export interface AppliedMigration {
  namespace: string;
  id: string;
  checksum: string;
  adopted: boolean;
  appliedAt: string;
}

export class MigrationStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationStateError';
  }
}

const createLedgerStatement = `CREATE TABLE IF NOT EXISTS ${migrationLedgerTable} (
  namespace TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (namespace, migration_id)
) STRICT`;

const expectedLedgerColumns = [
  ['namespace', 'TEXT', 1, 1],
  ['migration_id', 'TEXT', 1, 2],
  ['checksum', 'TEXT', 1, 0],
  ['adopted', 'INTEGER', 1, 0],
  ['applied_at', 'TEXT', 1, 0],
] as const;

interface LedgerColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SchemaSqlRow {
  sql: string | null;
}

interface LedgerRow {
  namespace: string;
  migration_id: string;
  checksum: string;
  adopted: number;
  applied_at: string;
}

export async function ensureMigrationLedger(
  db: SqliteDatabaseLike,
): Promise<void> {
  await db.batch([db.prepare(createLedgerStatement)]);
  const columns = await db
    .prepare(`PRAGMA table_info("${migrationLedgerTable}")`)
    .all<LedgerColumn>();
  const actual = columns.results.map((column) => [
    column.name,
    column.type.toUpperCase(),
    column.notnull,
    column.pk,
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(expectedLedgerColumns)) {
    throw new MigrationStateError(
      `${migrationLedgerTable} has an unsupported schema; expected the Gnolith migration ledger exactly`,
    );
  }
  const schema = await db
    .prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'table' AND name = ?`,
    )
    .bind(migrationLedgerTable)
    .all<SchemaSqlRow>();
  const actualSql = schema.results[0]?.sql;
  const expectedSql = createLedgerStatement.replace(
    'CREATE TABLE IF NOT EXISTS',
    'CREATE TABLE',
  );
  if (
    !actualSql ||
    (normalizeSchemaSql(actualSql) !==
      normalizeSchemaSql(createLedgerStatement) &&
      normalizeSchemaSql(actualSql) !== normalizeSchemaSql(expectedSql))
  ) {
    throw new MigrationStateError(
      `${migrationLedgerTable} must be the exact STRICT Gnolith ledger, including its primary key, default, and CHECK constraint`,
    );
  }
}

export async function readAppliedMigrations(
  db: SqliteDatabaseLike,
  namespace: string,
): Promise<AppliedMigration[]> {
  assertNamespace(namespace);
  const result = await db
    .prepare(
      `SELECT namespace, migration_id, checksum, adopted, applied_at
       FROM ${migrationLedgerTable}
       WHERE namespace = ?
       ORDER BY migration_id`,
    )
    .bind(namespace)
    .all<LedgerRow>();
  return result.results.map((row) => ({
    namespace: row.namespace,
    id: row.migration_id,
    checksum: row.checksum,
    adopted: row.adopted === 1,
    appliedAt: row.applied_at,
  }));
}

/** Apply one package namespace without knowing any other package's schema. */
export async function applyNamespacedMigrations(
  db: SqliteDatabaseLike,
  namespace: string,
  migrations: readonly NamespacedMigration[],
): Promise<AppliedMigration[]> {
  assertNamespace(namespace);
  assertMigrationOrder(migrations);
  await ensureMigrationLedger(db);
  const expected = await migrationChecksums(migrations);
  let applied = await readAppliedMigrations(db, namespace);
  validateApplied(namespace, applied, expected);

  for (const migration of migrations) {
    if (applied.some((record) => record.id === migration.id)) {
      continue;
    }
    const checksum = expected.get(migration.id);
    if (!checksum) {
      throw new MigrationStateError(
        `Unable to calculate checksum for ${namespace}/${migration.id}`,
      );
    }
    const appliedAt = new Date().toISOString();
    const statements = [
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare(
          `INSERT INTO ${migrationLedgerTable}
            (namespace, migration_id, checksum, adopted, applied_at)
           VALUES (?, ?, ?, 0, ?)`,
        )
        .bind(namespace, migration.id, checksum, appliedAt),
    ];
    try {
      await db.batch(statements);
    } catch (cause) {
      // A concurrent initializer may have committed the same migration first.
      applied = await readAppliedMigrations(db, namespace);
      const raced = applied.find((record) => record.id === migration.id);
      if (raced?.checksum === checksum) {
        continue;
      }
      throw new MigrationStateError(
        `Migration ${namespace}/${migration.id} failed; its schema and ledger entry were rolled back by the adapter batch`,
        { cause },
      );
    }
    applied = await readAppliedMigrations(db, namespace);
    validateApplied(namespace, applied, expected);
  }
  return applied;
}

/**
 * Record a caller-verified pre-ledger schema without replaying its DDL.
 * Package-owned adoption code must inspect its schema before calling this.
 */
export async function recordMigrationAdoption(
  db: SqliteDatabaseLike,
  namespace: string,
  migration: NamespacedMigration,
): Promise<void> {
  assertNamespace(namespace);
  await ensureMigrationLedger(db);
  const checksum = await checksumMigration(migration);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${migrationLedgerTable}
            (namespace, migration_id, checksum, adopted, applied_at)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .bind(namespace, migration.id, checksum, new Date().toISOString()),
    ]);
  } catch (cause) {
    const existing = (await readAppliedMigrations(db, namespace)).find(
      (record) => record.id === migration.id,
    );
    if (existing?.checksum === checksum) {
      return;
    }
    throw new MigrationStateError(
      `Could not adopt ${namespace}/${migration.id}; a conflicting ledger record exists`,
      { cause },
    );
  }
}

export async function checksumMigration(
  migration: NamespacedMigration,
): Promise<string> {
  assertMigration(migration);
  const content = JSON.stringify({
    id: migration.id,
    statements: migration.statements,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function migrationChecksums(
  migrations: readonly NamespacedMigration[],
): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      migrations.map(
        async (migration) =>
          [migration.id, await checksumMigration(migration)] as const,
      ),
    ),
  );
}

function validateApplied(
  namespace: string,
  applied: readonly AppliedMigration[],
  expected: ReadonlyMap<string, string>,
): void {
  for (const record of applied) {
    const checksum = expected.get(record.id);
    if (!checksum) {
      throw new MigrationStateError(
        `Database contains unknown or newer migration ${namespace}/${record.id}; upgrade the package or inspect the database before continuing`,
      );
    }
    if (checksum !== record.checksum) {
      throw new MigrationStateError(
        `Checksum drift detected for ${namespace}/${record.id}; applied migrations are immutable`,
      );
    }
  }
  const appliedIds = new Set(applied.map((record) => record.id));
  let foundGap = false;
  for (const id of expected.keys()) {
    if (!appliedIds.has(id)) {
      foundGap = true;
    } else if (foundGap) {
      throw new MigrationStateError(
        `Migration history for ${namespace} is partial or out of order at ${id}`,
      );
    }
  }
}

function assertMigrationOrder(migrations: readonly NamespacedMigration[]) {
  let previous: string | undefined;
  for (const migration of migrations) {
    assertMigration(migration);
    if (previous !== undefined && migration.id.localeCompare(previous) <= 0) {
      throw new TypeError('Migration IDs must be unique and strictly ordered');
    }
    previous = migration.id;
  }
}

function assertMigration(migration: NamespacedMigration): void {
  if (!migration.id || !migration.statements.length) {
    throw new TypeError(
      'Each migration requires an ID and at least one statement',
    );
  }
  if (migration.statements.some((statement) => !statement.trim())) {
    throw new TypeError('Migration statements must not be empty');
  }
}

function assertNamespace(namespace: string): void {
  if (!namespace.trim() || namespace.length > 200) {
    throw new TypeError(
      'Migration namespace must be a non-empty string of at most 200 characters',
    );
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toLowerCase();
}
