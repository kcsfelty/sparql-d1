import type {
  SqliteDatabaseLike,
  SqlitePreparedStatementLike,
} from './d1-types.js';
import { connectionIdFor } from './sql-identity.js';

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

export interface MigrationLedgerSliceEntry {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationLedgerSlice {
  readonly format: 'diamond-migration-ledger-slice-v1';
  readonly namespace: string;
  readonly entries: readonly MigrationLedgerSliceEntry[];
  readonly canonicalSha256: string;
}

export interface MigrationLedgerOwnerHandle {
  readonly ownerRegistrationId: string;
  readonly namespace: string;
  readonly installationId: string;
  readonly connectionId: string;
}

export interface MigrationAssemblyAuthority {
  readonly format: 'diamond-migration-assembly-authority-v1';
}

interface OwnerState {
  readonly db: SqliteDatabaseLike;
  readonly authority: MigrationAssemblyAuthority;
  readonly namespace: string;
  readonly installationId: string;
  readonly connectionId: string;
  readonly migrations: readonly NamespacedMigration[];
  readonly manifestDigest: string;
}

interface AuthorityState {
  readonly db: SqliteDatabaseLike;
  readonly installationId: string;
  readonly registrations: Map<string, string>;
}

const authorityStates = new WeakMap<
  MigrationAssemblyAuthority,
  AuthorityState
>();
const ownerStates = new WeakMap<MigrationLedgerOwnerHandle, OwnerState>();

export function createMigrationAssemblyAuthorityV1(
  db: SqliteDatabaseLike,
  installationId: string,
): MigrationAssemblyAuthority {
  assertInstallationId(installationId);
  const authority = Object.freeze({
    format: 'diamond-migration-assembly-authority-v1' as const,
  });
  authorityStates.set(authority, {
    db,
    installationId,
    registrations: new Map(),
  });
  return authority;
}

export async function registerMigrationLedgerOwnerV1(options: {
  readonly db: SqliteDatabaseLike;
  readonly installationId: string;
  readonly namespace: string;
  readonly migrations: readonly NamespacedMigration[];
  readonly assemblyAuthority: MigrationAssemblyAuthority;
}): Promise<MigrationLedgerOwnerHandle> {
  assertInstallationId(options.installationId);
  assertNamespace(options.namespace);
  assertMigrationOrder(options.migrations);
  const authority = authorityStates.get(options.assemblyAuthority);
  if (
    !authority ||
    authority.db !== options.db ||
    authority.installationId !== options.installationId
  ) {
    throw new MigrationStateError(
      'Migration assembly authority is forged or belongs to another connection or installation',
    );
  }
  const manifestDigest = await manifestSha256(options.migrations);
  const existing = authority.registrations.get(options.namespace);
  if (existing !== undefined) {
    throw new MigrationStateError(
      existing === manifestDigest
        ? `Migration namespace ${options.namespace} already has an owner registration`
        : `Migration namespace ${options.namespace} was registered with a different manifest`,
    );
  }
  await ensureMigrationLedger(options.db);
  const applied = await readAppliedMigrations(options.db, options.namespace);
  const expected = await migrationChecksums(options.migrations);
  validateApplied(options.namespace, applied, expected);

  const handle = Object.freeze({
    ownerRegistrationId: crypto.randomUUID(),
    namespace: options.namespace,
    installationId: options.installationId,
    connectionId: connectionIdFor(options.db),
  });
  authority.registrations.set(options.namespace, manifestDigest);
  ownerStates.set(handle, {
    db: options.db,
    authority: options.assemblyAuthority,
    namespace: options.namespace,
    installationId: options.installationId,
    connectionId: handle.connectionId,
    migrations: Object.freeze([...options.migrations]),
    manifestDigest,
  });
  return handle;
}

export interface MigrationLedgerBackup {
  verifyNamespace(
    owner: MigrationLedgerOwnerHandle,
    slice: MigrationLedgerSlice,
  ): Promise<void>;
  exportNamespace(
    owner: MigrationLedgerOwnerHandle,
  ): Promise<MigrationLedgerSlice>;
  validateNamespace(
    owner: MigrationLedgerOwnerHandle,
    slice: MigrationLedgerSlice,
  ): Promise<void>;
  restoreNamespace(
    owner: MigrationLedgerOwnerHandle,
    slice: MigrationLedgerSlice,
    options: Readonly<
      { mode: 'empty' } | { mode: 'exact-adopt'; confirmExactSchema: true }
    >,
  ): Promise<void>;
}

export function createMigrationLedgerBackupV1(
  db: SqliteDatabaseLike,
  assemblyAuthority: MigrationAssemblyAuthority,
): MigrationLedgerBackup {
  const authority = authorityStates.get(assemblyAuthority);
  if (!authority || authority.db !== db) {
    throw new MigrationStateError(
      'Migration backup authority is forged or belongs to another connection',
    );
  }
  return Object.freeze({
    async verifyNamespace(
      owner: MigrationLedgerOwnerHandle,
      slice: MigrationLedgerSlice,
    ) {
      const state = requireOwner(owner, db, assemblyAuthority);
      await verifyLedgerSlice(state, slice);
    },
    async exportNamespace(owner: MigrationLedgerOwnerHandle) {
      const state = requireOwner(owner, db, assemblyAuthority);
      const applied = await readAppliedMigrations(db, state.namespace);
      await requireCompleteManifest(state, applied);
      return createLedgerSlice(state.namespace, applied);
    },
    async validateNamespace(
      owner: MigrationLedgerOwnerHandle,
      slice: MigrationLedgerSlice,
    ) {
      const state = requireOwner(owner, db, assemblyAuthority);
      await verifyLedgerSlice(state, slice);
      const applied = await readAppliedMigrations(db, state.namespace);
      await requireCompleteManifest(state, applied);
      if (!sameSliceEntries(applied, slice.entries)) {
        throw new MigrationStateError(
          `Live ledger for ${state.namespace} does not match the supplied slice`,
        );
      }
    },
    async restoreNamespace(
      owner: MigrationLedgerOwnerHandle,
      slice: MigrationLedgerSlice,
      options:
        { mode: 'empty' } | { mode: 'exact-adopt'; confirmExactSchema: true },
    ) {
      await restoreMigrationLedgerNamespaceWithStatements(
        db,
        owner,
        slice,
        options,
        [],
      );
    },
  });
}

/** @internal Atomic composition seam used by owner-scoped backup modules. */
export async function restoreMigrationLedgerNamespaceWithStatements(
  db: SqliteDatabaseLike,
  owner: MigrationLedgerOwnerHandle,
  slice: MigrationLedgerSlice,
  options:
    { mode: 'empty' } | { mode: 'exact-adopt'; confirmExactSchema: true },
  additionalStatements: readonly SqlitePreparedStatementLike[],
): Promise<void> {
  const known = ownerStates.get(owner);
  if (!known) {
    throw new MigrationStateError('Migration owner handle is forged');
  }
  const state = requireOwner(owner, db, known.authority);
  await verifyLedgerSlice(state, slice);
  const applied = await readAppliedMigrations(db, state.namespace);
  if (applied.length !== 0) {
    throw new MigrationStateError(
      `Cannot restore non-empty ledger namespace ${state.namespace}`,
    );
  }
  const entries = new Map(slice.entries.map((entry) => [entry.id, entry]));
  const statements: SqlitePreparedStatementLike[] = [];
  for (const migration of state.migrations) {
    if (options.mode === 'empty') {
      statements.push(...migration.statements.map((sql) => db.prepare(sql)));
    }
    const entry = entries.get(migration.id)!;
    statements.push(
      db
        .prepare(
          `INSERT INTO ${migrationLedgerTable}
            (namespace, migration_id, checksum, adopted, applied_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          state.namespace,
          entry.id,
          entry.checksum,
          options.mode === 'exact-adopt' ? 1 : 0,
          entry.appliedAt,
        ),
    );
  }
  await db.batch([...statements, ...additionalStatements]);
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

function assertInstallationId(installationId: string): void {
  if (!installationId.trim() || installationId.length > 200) {
    throw new TypeError(
      'Installation ID must be a non-empty string of at most 200 characters',
    );
  }
}

async function manifestSha256(
  migrations: readonly NamespacedMigration[],
): Promise<string> {
  return sha256(
    canonicalJson(
      await Promise.all(
        migrations.map(async (migration) => ({
          checksum: await checksumMigration(migration),
          id: migration.id,
        })),
      ),
    ),
  );
}

function requireOwner(
  owner: MigrationLedgerOwnerHandle,
  db: SqliteDatabaseLike,
  authority: MigrationAssemblyAuthority,
): OwnerState {
  const state = ownerStates.get(owner);
  if (
    !state ||
    state.db !== db ||
    state.authority !== authority ||
    state.connectionId !== connectionIdFor(db) ||
    owner.namespace !== state.namespace ||
    owner.installationId !== state.installationId ||
    owner.connectionId !== state.connectionId
  ) {
    throw new MigrationStateError(
      'Migration owner handle is forged, serialized, or belongs to another owner, connection, or installation',
    );
  }
  return state;
}

async function requireCompleteManifest(
  state: OwnerState,
  applied: readonly AppliedMigration[],
): Promise<void> {
  const expected = await migrationChecksums(state.migrations);
  validateApplied(state.namespace, applied, expected);
  if (applied.length !== state.migrations.length) {
    throw new MigrationStateError(
      `Migration history for ${state.namespace} is incomplete`,
    );
  }
}

async function createLedgerSlice(
  namespace: string,
  applied: readonly AppliedMigration[],
): Promise<MigrationLedgerSlice> {
  const entries = applied.map((entry) =>
    Object.freeze({
      id: entry.id,
      checksum: entry.checksum,
      appliedAt: entry.appliedAt,
    }),
  );
  const unsigned = {
    format: 'diamond-migration-ledger-slice-v1' as const,
    namespace,
    entries,
  };
  return Object.freeze({
    ...unsigned,
    entries: Object.freeze(entries),
    canonicalSha256: await sha256(canonicalJson(unsigned)),
  });
}

async function verifyLedgerSlice(
  state: OwnerState,
  slice: MigrationLedgerSlice,
): Promise<void> {
  if (
    slice.format !== 'diamond-migration-ledger-slice-v1' ||
    slice.namespace !== state.namespace ||
    typeof slice.canonicalSha256 !== 'string' ||
    !Array.isArray(slice.entries)
  ) {
    throw new MigrationStateError(
      'Migration ledger slice format or namespace is invalid',
    );
  }
  const digest = await sha256(
    canonicalJson({
      format: slice.format,
      namespace: slice.namespace,
      entries: slice.entries,
    }),
  );
  if (digest !== slice.canonicalSha256) {
    throw new MigrationStateError(
      `Migration ledger slice digest mismatch for ${state.namespace}`,
    );
  }
  const expected = await migrationChecksums(state.migrations);
  if (
    slice.entries.length !== state.migrations.length ||
    slice.entries.some(
      (entry, index) =>
        entry.id !== state.migrations[index]?.id ||
        entry.checksum !== expected.get(entry.id) ||
        !entry.appliedAt,
    )
  ) {
    throw new MigrationStateError(
      `Migration ledger slice does not match the registered manifest for ${state.namespace}`,
    );
  }
  if ((await manifestSha256(state.migrations)) !== state.manifestDigest) {
    throw new MigrationStateError(
      `Registered migration manifest changed for ${state.namespace}`,
    );
  }
}

function sameSliceEntries(
  applied: readonly AppliedMigration[],
  entries: readonly MigrationLedgerSliceEntry[],
): boolean {
  return (
    applied.length === entries.length &&
    applied.every(
      (entry, index) =>
        entry.id === entries[index]?.id &&
        entry.checksum === entries[index]?.checksum &&
        entry.appliedAt === entries[index]?.appliedAt,
    )
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot encode non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON received an unsupported value');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
