import type { SqlDatabase, SqlReadDatabase, SqlStatement } from './d1-types.js';
import type {
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
} from './migrations.js';
import { restoreMigrationLedgerNamespaceWithStatements } from './migrations.js';
import { checksumMigration } from './migrations.js';
import {
  diamondMigrationNamespace,
  diamondMigrations,
  expectedStoreIndexes,
  inspectStoreSchema,
  schemaStatements,
} from './schema.js';

export interface DiamondBackupSection {
  readonly owner: 'diamond';
  readonly formatVersion: 1;
  readonly schemaVersion: 1;
  readonly ledger: MigrationLedgerSlice;
  readonly payload: Uint8Array;
  readonly sha256: string;
}

export interface DiamondBackupInspection {
  readonly schemaPresent: boolean;
  readonly schemaValid: boolean;
  readonly quadCount: number;
  readonly guardCount: number;
}

export interface DiamondBackupImportReport {
  readonly dryRun: boolean;
  readonly action: 'import' | 'rebuild-required';
  readonly quadCount: number;
  readonly guardCount: number;
  readonly message: string;
}

export interface DiamondBackupValidationReport {
  readonly valid: true;
  readonly quadCount: number;
  readonly guardCount: number;
  readonly payloadBytes: number;
  readonly sha256: string;
}

export interface DiamondBackup {
  inspect(): Promise<DiamondBackupInspection>;
  export(): Promise<DiamondBackupSection>;
  dryRunImport(
    section: DiamondBackupSection,
    options: DiamondBackupImportOptions,
  ): Promise<DiamondBackupImportReport>;
  import(
    section: DiamondBackupSection,
    options: DiamondBackupImportOptions,
  ): Promise<DiamondBackupImportReport>;
}

export type DiamondBackupImportOptions =
  | { readonly mode: 'empty' }
  | { readonly mode: 'migration-bound' }
  | { readonly mode: 'rebuild' };

export interface Diamond041PackageAttestation {
  readonly packageName: '@gnolith/diamond';
  readonly packageVersion: '0.4.1';
}

export interface DiamondLegacyOwnerDecodeLimits {
  readonly maxQuads?: number;
  readonly maxPayloadBytes?: number;
}

export interface DiamondLegacyOwnerCounts {
  readonly quads: number;
  readonly patchGuards: number;
}

export interface DiamondLegacyOwnerDigests {
  readonly quadsSha256: string;
  readonly patchGuardsSha256: string;
  readonly payloadSha256: string;
}

/**
 * Read-only evidence for one exact 0.4.1 Diamond owner. The payload is held in
 * a private in-memory brand and can only be adopted with the function below.
 */
export interface DiamondLegacyOwnerFragment {
  readonly format: 'diamond-legacy-owner-fragment-v1';
  readonly source: Diamond041PackageAttestation;
  readonly counts: DiamondLegacyOwnerCounts;
  readonly digests: DiamondLegacyOwnerDigests;
  readonly ledger: MigrationLedgerSlice;
}

interface BackupPayload {
  readonly format: 'diamond-backup-payload-v1';
  readonly quads: readonly QuadBackupRow[];
  readonly guards: readonly string[];
}

interface QuadBackupRow {
  readonly id: number;
  readonly subject_key: string;
  readonly subject_json: string;
  readonly predicate_key: string;
  readonly predicate_json: string;
  readonly object_key: string;
  readonly object_json: string;
  readonly graph_key: string;
  readonly graph_json: string;
}

const controllers = new WeakSet<DiamondBackup>();
const legacyFragments = new WeakMap<
  DiamondLegacyOwnerFragment,
  DiamondBackupSection
>();

const DEFAULT_LEGACY_MAX_QUADS = 100_000;
const HARD_LEGACY_MAX_QUADS = 1_000_000;
const DEFAULT_LEGACY_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const HARD_LEGACY_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export async function decodeDiamond041LegacyOwnerV1(options: {
  readonly source: SqlReadDatabase;
  readonly attestation: Diamond041PackageAttestation;
  readonly limits?: DiamondLegacyOwnerDecodeLimits;
}): Promise<DiamondLegacyOwnerFragment> {
  assertDiamond041Attestation(options.attestation);
  const limits = legacyDecodeLimits(options.limits);
  await assertExactDiamond041Schema(options.source);
  const ledger = await readDiamond041Ledger(options.source);
  const [quadCount, guardCount] = await Promise.all([
    readLegacyCount(options.source, 'rdf_quads'),
    readLegacyCount(options.source, 'rdf_patch_guards'),
  ]);
  if (quadCount > limits.maxQuads) {
    throw new RangeError(
      `Diamond 0.4.1 source contains ${quadCount} quads; configured maximum is ${limits.maxQuads}`,
    );
  }
  if (guardCount > limits.maxQuads) {
    throw new RangeError(
      `Diamond 0.4.1 source contains ${guardCount} patch guards; configured maximum is ${limits.maxQuads}`,
    );
  }
  const [quads, guards] = await Promise.all([
    options.source
      .prepare(
        `SELECT id, subject_key, subject_json, predicate_key,
                predicate_json, object_key, object_json, graph_key,
                graph_json
         FROM rdf_quads ORDER BY id`,
      )
      .all<QuadBackupRow>(),
    options.source
      .prepare('SELECT patch_id FROM rdf_patch_guards ORDER BY patch_id')
      .all<{ patch_id: string }>(),
  ]);
  if (
    quads.results.length !== quadCount ||
    guards.results.length !== guardCount ||
    quads.results.some((row) => !isQuadBackupRow(row)) ||
    guards.results.some(
      (row) => typeof row.patch_id !== 'string' || !row.patch_id,
    )
  ) {
    throw new Error(
      'Diamond 0.4.1 source changed while its owner fragment was decoded',
    );
  }
  const guardIds = guards.results.map((row) => row.patch_id);
  const payload = new TextEncoder().encode(
    canonicalJson({
      format: 'diamond-backup-payload-v1',
      quads: quads.results,
      guards: guardIds,
    }),
  );
  if (payload.byteLength > limits.maxPayloadBytes) {
    throw new RangeError(
      `Diamond 0.4.1 owner payload is ${payload.byteLength} bytes; configured maximum is ${limits.maxPayloadBytes}`,
    );
  }
  const [quadsSha256, patchGuardsSha256, payloadSha256] = await Promise.all([
    sha256(new TextEncoder().encode(canonicalJson(quads.results))),
    sha256(new TextEncoder().encode(canonicalJson(guardIds))),
    sha256(payload),
  ]);
  const section = Object.freeze({
    owner: 'diamond' as const,
    formatVersion: 1 as const,
    schemaVersion: 1 as const,
    ledger,
    payload,
    sha256: payloadSha256,
  });
  const fragment = Object.freeze({
    format: 'diamond-legacy-owner-fragment-v1' as const,
    source: Object.freeze({ ...options.attestation }),
    counts: Object.freeze({ quads: quadCount, patchGuards: guardCount }),
    digests: Object.freeze({
      quadsSha256,
      patchGuardsSha256,
      payloadSha256,
    }),
    ledger,
  });
  legacyFragments.set(fragment, section);
  return fragment;
}

export function adoptDiamond041LegacyOwnerV1(
  fragment: DiamondLegacyOwnerFragment,
): DiamondBackupSection {
  const section = legacyFragments.get(fragment);
  if (!section) {
    throw new TypeError(
      'Diamond legacy owner fragment is forged, serialized, or from another process',
    );
  }
  return section;
}

/**
 * Validate an archive without receiving a database capability. This performs
 * no I/O and cannot inspect or mutate a live installation.
 */
export async function validateDiamondBackupSectionV1(
  section: DiamondBackupSection,
): Promise<DiamondBackupValidationReport> {
  const payload = await validateSection(section);
  return Object.freeze({
    valid: true as const,
    quadCount: payload.quads.length,
    guardCount: payload.guards.length,
    payloadBytes: section.payload.byteLength,
    sha256: section.sha256,
  });
}

export function createDiamondBackupV1(options: {
  readonly db: SqlDatabase;
  readonly owner: MigrationLedgerOwnerHandle;
  readonly ledgerBackup: MigrationLedgerBackup;
}): DiamondBackup {
  if (options.owner.namespace !== '@gnolith/diamond') {
    throw new TypeError('Diamond backup requires the Diamond migration owner');
  }
  const controller: DiamondBackup = Object.freeze({
    inspect: () => inspect(options.db),
    async export() {
      assertController(controller);
      const inspection = await inspect(options.db);
      if (!inspection.schemaValid) {
        throw new Error('Diamond backup export requires the exact live schema');
      }
      const [quads, guards, ledger] = await Promise.all([
        options.db
          .prepare(
            `SELECT id, subject_key, subject_json, predicate_key,
                    predicate_json, object_key, object_json, graph_key,
                    graph_json
             FROM rdf_quads ORDER BY id`,
          )
          .all<QuadBackupRow>(),
        options.db
          .prepare('SELECT patch_id FROM rdf_patch_guards ORDER BY patch_id')
          .all<{ patch_id: string }>(),
        options.ledgerBackup.exportNamespace(options.owner),
      ]);
      const payload = new TextEncoder().encode(
        canonicalJson({
          format: 'diamond-backup-payload-v1',
          quads: quads.results,
          guards: guards.results.map((row) => row.patch_id),
        }),
      );
      return Object.freeze({
        owner: 'diamond' as const,
        formatVersion: 1 as const,
        schemaVersion: 1 as const,
        ledger,
        payload,
        sha256: await sha256(payload),
      });
    },
    async dryRunImport(
      section: DiamondBackupSection,
      importOptions: DiamondBackupImportOptions,
    ) {
      assertController(controller);
      return planImport(options, section, importOptions, true);
    },
    async import(
      section: DiamondBackupSection,
      importOptions: DiamondBackupImportOptions,
    ) {
      assertController(controller);
      return planImport(options, section, importOptions, false);
    },
  });
  controllers.add(controller);
  return controller;
}

async function inspect(db: SqlDatabase): Promise<DiamondBackupInspection> {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name IN ('rdf_quads', 'rdf_patch_guards')
       ORDER BY name`,
    )
    .all<{ name: string }>();
  if (tables.results.length === 0) {
    return {
      schemaPresent: false,
      schemaValid: false,
      quadCount: 0,
      guardCount: 0,
    };
  }
  const schema = await inspectStoreSchema(db);
  const [quadCount, guardCount] = await Promise.all([
    count(db, 'rdf_quads'),
    count(db, 'rdf_patch_guards'),
  ]);
  return {
    schemaPresent: true,
    schemaValid: schema.valid,
    quadCount,
    guardCount,
  };
}

async function planImport(
  options: {
    readonly db: SqlDatabase;
    readonly owner: MigrationLedgerOwnerHandle;
    readonly ledgerBackup: MigrationLedgerBackup;
  },
  section: DiamondBackupSection,
  importOptions: DiamondBackupImportOptions,
  dryRun: boolean,
): Promise<DiamondBackupImportReport> {
  const payload = await validateSection(section);
  await options.ledgerBackup.verifyNamespace(options.owner, section.ledger);
  if (importOptions.mode === 'rebuild') {
    return {
      dryRun,
      action: 'rebuild-required',
      quadCount: payload.quads.length,
      guardCount: payload.guards.length,
      message:
        'RDF rebuild was explicitly selected; this backup section was not imported or discarded.',
    };
  }
  const before = await inspect(options.db);
  if (before.quadCount !== 0 || before.guardCount !== 0) {
    throw new Error('Diamond backup import requires empty Diamond tables');
  }
  if (importOptions.mode === 'migration-bound') {
    if (!before.schemaValid) {
      throw new Error(
        'Migration-bound import requires the exact Diamond schema',
      );
    }
    await options.ledgerBackup.validateNamespace(options.owner, section.ledger);
  }
  if (dryRun) {
    return importReport(true, payload);
  }
  if (importOptions.mode === 'empty' && before.schemaPresent) {
    throw new Error('Empty-target import requires Diamond tables to be absent');
  }
  const statements: SqlStatement[] = [];
  for (const row of payload.quads) {
    statements.push(
      options.db
        .prepare(
          `INSERT INTO rdf_quads
           (id, subject_key, subject_json, predicate_key, predicate_json,
            object_key, object_json, graph_key, graph_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.subject_key,
          row.subject_json,
          row.predicate_key,
          row.predicate_json,
          row.object_key,
          row.object_json,
          row.graph_key,
          row.graph_json,
        ),
    );
  }
  for (const patchId of payload.guards) {
    statements.push(
      options.db
        .prepare('INSERT INTO rdf_patch_guards (patch_id) VALUES (?)')
        .bind(patchId),
    );
  }
  if (importOptions.mode === 'empty') {
    await restoreMigrationLedgerNamespaceWithStatements(
      options.db,
      options.owner,
      section.ledger,
      { mode: 'empty' },
      statements,
    );
  } else if (statements.length > 0) {
    await options.db.batch(statements);
  }
  return importReport(false, payload);
}

async function validateSection(
  section: DiamondBackupSection,
): Promise<BackupPayload> {
  const payload = await verifySection(section);
  await verifyDiamondLedgerSlice(section.ledger);
  return payload;
}

async function verifySection(
  section: DiamondBackupSection,
): Promise<BackupPayload> {
  if (
    section.owner !== 'diamond' ||
    section.formatVersion !== 1 ||
    section.schemaVersion !== 1 ||
    !(section.payload instanceof Uint8Array)
  ) {
    throw new TypeError('Unsupported Diamond backup section');
  }
  if ((await sha256(section.payload)) !== section.sha256) {
    throw new Error('Diamond backup payload checksum mismatch');
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
    section.payload,
  );
  const parsed = JSON.parse(decoded) as BackupPayload;
  if (
    parsed.format !== 'diamond-backup-payload-v1' ||
    !Array.isArray(parsed.quads) ||
    !Array.isArray(parsed.guards) ||
    parsed.guards.some((guard) => typeof guard !== 'string' || !guard) ||
    parsed.quads.some((row) => !isQuadBackupRow(row)) ||
    new Set(parsed.guards).size !== parsed.guards.length ||
    new Set(parsed.quads.map((row) => row.id)).size !== parsed.quads.length ||
    canonicalJson(parsed) !== decoded
  ) {
    throw new TypeError('Invalid Diamond backup payload');
  }
  return parsed;
}

async function verifyDiamondLedgerSlice(
  ledger: MigrationLedgerSlice,
): Promise<void> {
  if (
    ledger?.format !== 'diamond-migration-ledger-slice-v1' ||
    ledger.namespace !== diamondMigrationNamespace ||
    typeof ledger.canonicalSha256 !== 'string' ||
    !Array.isArray(ledger.entries)
  ) {
    throw new TypeError('Invalid Diamond backup migration ledger');
  }
  const digest = await sha256(
    new TextEncoder().encode(
      canonicalJson({
        format: ledger.format,
        namespace: ledger.namespace,
        entries: ledger.entries,
      }),
    ),
  );
  if (digest !== ledger.canonicalSha256) {
    throw new Error('Diamond backup migration ledger checksum mismatch');
  }
  const expectedChecksums = new Map(
    await Promise.all(
      diamondMigrations.map(
        async (migration) =>
          [migration.id, await checksumMigration(migration)] as const,
      ),
    ),
  );
  if (
    ledger.entries.length !== diamondMigrations.length ||
    ledger.entries.some(
      (entry, index) =>
        !entry ||
        typeof entry !== 'object' ||
        entry.id !== diamondMigrations[index]?.id ||
        entry.checksum !== expectedChecksums.get(entry.id) ||
        typeof entry.appliedAt !== 'string' ||
        !entry.appliedAt,
    )
  ) {
    throw new TypeError(
      'Diamond backup migration ledger does not match the exact Diamond manifest',
    );
  }
}

function isQuadBackupRow(value: unknown): value is QuadBackupRow {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.id) &&
    Number(row.id) > 0 &&
    [
      'subject_key',
      'subject_json',
      'predicate_key',
      'predicate_json',
      'object_key',
      'object_json',
      'graph_key',
      'graph_json',
    ].every((field) => typeof row[field] === 'string')
  );
}

function importReport(
  dryRun: boolean,
  payload: BackupPayload,
): DiamondBackupImportReport {
  return {
    dryRun,
    action: 'import',
    quadCount: payload.quads.length,
    guardCount: payload.guards.length,
    message: dryRun
      ? 'Backup is valid and can be imported without touching foreign tables.'
      : 'Backup imported; foreign tables and migration namespaces were untouched.',
  };
}

async function count(db: SqlDatabase, table: string): Promise<number> {
  const result = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .all<{ count: number | bigint }>();
  return Number(result.results[0]?.count ?? 0);
}

function assertDiamond041Attestation(
  attestation: Diamond041PackageAttestation,
): void {
  if (
    attestation?.packageName !== '@gnolith/diamond' ||
    attestation.packageVersion !== '0.4.1'
  ) {
    throw new TypeError(
      'Legacy owner decoder accepts only an exact @gnolith/diamond@0.4.1 attestation',
    );
  }
}

function legacyDecodeLimits(
  limits: DiamondLegacyOwnerDecodeLimits | undefined,
): { maxQuads: number; maxPayloadBytes: number } {
  const maxQuads = limits?.maxQuads ?? DEFAULT_LEGACY_MAX_QUADS;
  const maxPayloadBytes =
    limits?.maxPayloadBytes ?? DEFAULT_LEGACY_MAX_PAYLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxQuads) ||
    maxQuads <= 0 ||
    maxQuads > HARD_LEGACY_MAX_QUADS
  ) {
    throw new RangeError(
      `maxQuads must be a positive safe integer no greater than ${HARD_LEGACY_MAX_QUADS}`,
    );
  }
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes <= 0 ||
    maxPayloadBytes > HARD_LEGACY_MAX_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      `maxPayloadBytes must be a positive safe integer no greater than ${HARD_LEGACY_MAX_PAYLOAD_BYTES}`,
    );
  }
  return { maxQuads, maxPayloadBytes };
}

interface LegacySchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

const legacyExpectedObjects = new Map<string, string | null>([
  ['rdf_quads', schemaStatements[0]],
  ['rdf_patch_guards', schemaStatements[1]],
  ['sqlite_autoindex_rdf_quads_1', null],
  ['sqlite_autoindex_rdf_patch_guards_1', null],
  ['rdf_quads_pogs_idx', schemaStatements[2]],
  ['rdf_quads_ogsp_idx', schemaStatements[3]],
  ['rdf_quads_gspo_idx', schemaStatements[4]],
]);

const legacyQuadColumns = [
  ['id', 'INTEGER', 0, 1],
  ['subject_key', 'TEXT', 1, 0],
  ['subject_json', 'TEXT', 1, 0],
  ['predicate_key', 'TEXT', 1, 0],
  ['predicate_json', 'TEXT', 1, 0],
  ['object_key', 'TEXT', 1, 0],
  ['object_json', 'TEXT', 1, 0],
  ['graph_key', 'TEXT', 1, 0],
  ['graph_json', 'TEXT', 1, 0],
] as const;

const legacyGuardColumns = [['patch_id', 'TEXT', 1, 1]] as const;
const legacyLedgerColumns = [
  ['namespace', 'TEXT', 1, 1],
  ['migration_id', 'TEXT', 1, 2],
  ['checksum', 'TEXT', 1, 0],
  ['adopted', 'INTEGER', 1, 0],
  ['applied_at', 'TEXT', 1, 0],
] as const;

async function assertExactDiamond041Schema(
  source: SqlReadDatabase,
): Promise<void> {
  const objects = await source
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name IN (
         'rdf_quads', 'rdf_patch_guards',
         'sqlite_autoindex_rdf_quads_1',
         'sqlite_autoindex_rdf_patch_guards_1',
         'rdf_quads_pogs_idx', 'rdf_quads_ogsp_idx', 'rdf_quads_gspo_idx'
       )
       OR tbl_name IN ('rdf_quads', 'rdf_patch_guards')
       ORDER BY type, name`,
    )
    .all<LegacySchemaObject>();
  const byName = new Map(
    objects.results.map((object) => [object.name, object]),
  );
  if (
    objects.results.length !== legacyExpectedObjects.size ||
    [...legacyExpectedObjects].some(([name, expectedSql]) => {
      const actual = byName.get(name);
      return (
        !actual ||
        actual.tbl_name !==
          (name.startsWith('sqlite_autoindex_rdf_patch_guards') ||
          name === 'rdf_patch_guards'
            ? 'rdf_patch_guards'
            : 'rdf_quads') ||
        !legacySqlMatches(actual.sql, expectedSql)
      );
    })
  ) {
    throw new Error(
      'Source is not the exact Diamond 0.4.1 owned table/index schema',
    );
  }
  await Promise.all([
    assertLegacyColumns(source, 'rdf_quads', legacyQuadColumns),
    assertLegacyColumns(source, 'rdf_patch_guards', legacyGuardColumns),
    ...Object.entries(expectedStoreIndexes).map(
      async ([indexName, expectedColumns]) => {
        const result = await source
          .prepare(`PRAGMA index_info("${indexName}")`)
          .all<{ name: string; seqno: number }>();
        const actual = [...result.results]
          .sort((left, right) => left.seqno - right.seqno)
          .map((row) => row.name);
        if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
          throw new Error(
            `Source Diamond 0.4.1 index ${indexName} has unexpected columns`,
          );
        }
      },
    ),
  ]);
}

async function assertLegacyColumns(
  source: SqlReadDatabase,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
): Promise<void> {
  const result = await source
    .prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string; type: string; notnull: number; pk: number }>();
  const actual = result.results.map((column) => [
    column.name,
    column.type.toUpperCase(),
    column.notnull,
    column.pk,
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Source Diamond 0.4.1 table ${table} has unexpected columns`,
    );
  }
}

function legacySqlMatches(
  actual: string | null,
  expected: string | null,
): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (actual === null) {
    return false;
  }
  const unconditional = expected
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')
    .replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX');
  return normalizeLegacySql(actual) === normalizeLegacySql(unconditional);
}

function normalizeLegacySql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toLowerCase();
}

async function readDiamond041Ledger(
  source: SqlReadDatabase,
): Promise<MigrationLedgerSlice> {
  await assertLegacyColumns(source, '_gnolith_migrations', legacyLedgerColumns);
  const schema = await source
    .prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'table' AND name = '_gnolith_migrations'`,
    )
    .all<{ sql: string | null }>();
  const ledgerSql = schema.results[0]?.sql;
  if (
    !ledgerSql ||
    normalizeLegacySql(ledgerSql) !==
      normalizeLegacySql(`CREATE TABLE _gnolith_migrations (
        namespace TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
        applied_at TEXT NOT NULL,
        PRIMARY KEY (namespace, migration_id)
      ) STRICT`)
  ) {
    throw new Error('Source has an unsupported Diamond 0.4.1 migration ledger');
  }
  const rows = await source
    .prepare(
      `SELECT migration_id, checksum, applied_at
       FROM _gnolith_migrations
       WHERE namespace = ?
       ORDER BY migration_id`,
    )
    .bind(diamondMigrationNamespace)
    .all<{ migration_id: string; checksum: string; applied_at: string }>();
  const migration = diamondMigrations[0]!;
  const expectedChecksum = await checksumMigration(migration);
  if (
    rows.results.length !== 1 ||
    rows.results[0]?.migration_id !== migration.id ||
    rows.results[0]?.checksum !== expectedChecksum ||
    !rows.results[0]?.applied_at
  ) {
    throw new Error(
      'Source does not contain exact Diamond 0.4.1 namespace-ledger evidence',
    );
  }
  const entries = Object.freeze([
    Object.freeze({
      id: migration.id,
      checksum: expectedChecksum,
      appliedAt: rows.results[0].applied_at,
    }),
  ]);
  const unsigned = {
    format: 'diamond-migration-ledger-slice-v1' as const,
    namespace: diamondMigrationNamespace,
    entries,
  };
  return Object.freeze({
    ...unsigned,
    canonicalSha256: await sha256(
      new TextEncoder().encode(canonicalJson(unsigned)),
    ),
  });
}

async function readLegacyCount(
  source: SqlReadDatabase,
  table: 'rdf_quads' | 'rdf_patch_guards',
): Promise<number> {
  const result = await source
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .all<{ count: number | bigint }>();
  const value = Number(result.results[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Source Diamond 0.4.1 ${table} count is invalid`);
  }
  return value;
}

function assertController(controller: DiamondBackup): void {
  if (!controllers.has(controller)) {
    throw new TypeError('Diamond backup controller is forged');
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
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
  throw new TypeError('Backup payload contains an unsupported value');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
