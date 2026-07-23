import type { SqlDatabase, SqlStatement } from './d1-types.js';
import type {
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
} from './migrations.js';
import { restoreMigrationLedgerNamespaceWithStatements } from './migrations.js';
import { inspectStoreSchema } from './schema.js';

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
  const payload = await verifySection(section);
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
