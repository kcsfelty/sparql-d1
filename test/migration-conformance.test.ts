import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../src/d1-types.js';
import {
  MigrationStateError,
  applyNamespacedMigrations,
  checksumMigration,
  ensureMigrationLedger,
  migrationLedgerTable,
  readAppliedMigrations,
} from '../src/migrations.js';
import { NodeSqliteDatabase } from '../src/node-sqlite.js';
import {
  diamondMigrationNamespace,
  initializeStore,
  schemaStatements,
} from '../src/schema.js';
import { MemoryD1 } from './memory-d1.js';

interface TestDatabase extends D1DatabaseLike {
  close(): void | Promise<void>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const adapters: Array<{
  name: string;
  create(): Promise<TestDatabase>;
}> = [
  {
    name: 'D1-compatible SQLite harness',
    create: async () => new MemoryD1(),
  },
  {
    name: 'node:sqlite adapter',
    create: async () => {
      const directory = await mkdtemp(join(tmpdir(), 'diamond-migrations-'));
      temporaryDirectories.push(directory);
      return new NodeSqliteDatabase(join(directory, 'database.sqlite'));
    },
  },
];

for (const adapter of adapters) {
  describe(`migration conformance: ${adapter.name}`, () => {
    it('migrates an empty database and repeats as a no-op', async () => {
      const db = await adapter.create();
      try {
        await initializeStore(db);
        const first = await readAppliedMigrations(
          db,
          diamondMigrationNamespace,
        );
        await initializeStore(db);
        const repeated = await readAppliedMigrations(
          db,
          diamondMigrationNamespace,
        );
        expect(repeated).toEqual(first);
        expect(first).toMatchObject([
          { id: '0001-current-rdf-schema', adopted: false },
        ]);
      } finally {
        await db.close();
      }
    });

    it('adopts an exact pre-ledger store without losing quads', async () => {
      const db = await adapter.create();
      try {
        await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
        await db
          .prepare(
            `INSERT INTO rdf_quads (
              subject_key, subject_json, predicate_key, predicate_json,
              object_key, object_json, graph_key, graph_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind('s', '{}', 'p', '{}', 'o', '{}', 'g', '{}')
          .run();
        await initializeStore(db);
        const records = await readAppliedMigrations(
          db,
          diamondMigrationNamespace,
        );
        expect(records).toMatchObject([{ adopted: true }]);
        const count = await db
          .prepare('SELECT COUNT(*) AS count FROM rdf_quads')
          .all<{ count: number }>();
        expect(count.results[0]?.count).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('rejects a partial pre-ledger schema without repairing it', async () => {
      const db = await adapter.create();
      try {
        await db
          .prepare('CREATE TABLE rdf_quads (id INTEGER PRIMARY KEY) STRICT')
          .run();
        await expect(initializeStore(db)).rejects.toThrow(
          /partial or ambiguous/u,
        );
        const columns = await db
          .prepare('PRAGMA table_info("rdf_quads")')
          .all<{ name: string }>();
        expect(columns.results.map(({ name }) => name)).toEqual(['id']);
        expect(
          await readAppliedMigrations(db, diamondMigrationNamespace),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    });

    it('fails closed on a pre-ledger trigger with an unrelated name', async () => {
      const db = await adapter.create();
      try {
        await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
        await db.prepare('CREATE TABLE unrelated (value INTEGER)').run();
        await db
          .prepare(
            `CREATE TRIGGER innocuous_name AFTER INSERT ON unrelated BEGIN
               DELETE FROM rdf_quads WHERE id = NEW.value;
             END`,
          )
          .run();
        await expect(initializeStore(db)).rejects.toThrow(
          /innocuous_name|partial|ambiguous/u,
        );
        expect(
          await readAppliedMigrations(db, diamondMigrationNamespace),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    });

    it('fails closed on wrong-table and partial expected indexes', async () => {
      const wrongTable = await adapter.create();
      try {
        await wrongTable.batch(
          schemaStatements.map((sql) => wrongTable.prepare(sql)),
        );
        await wrongTable.prepare('DROP INDEX rdf_quads_pogs_idx').run();
        await wrongTable
          .prepare(
            `CREATE TABLE unrelated_index_target (
              predicate_key TEXT NOT NULL,
              object_key TEXT NOT NULL,
              graph_key TEXT NOT NULL,
              subject_key TEXT NOT NULL
            ) STRICT`,
          )
          .run();
        await wrongTable
          .prepare(
            `CREATE INDEX rdf_quads_pogs_idx ON unrelated_index_target(
              predicate_key, object_key, graph_key, subject_key
            )`,
          )
          .run();
        await expect(initializeStore(wrongTable)).rejects.toThrow(
          /belongs to unrelated_index_target|partial|ambiguous/u,
        );
        expect(
          await readAppliedMigrations(wrongTable, diamondMigrationNamespace),
        ).toEqual([]);
      } finally {
        await wrongTable.close();
      }

      const partial = await adapter.create();
      try {
        await partial.batch(
          schemaStatements.map((sql) => partial.prepare(sql)),
        );
        await partial.prepare('DROP INDEX rdf_quads_pogs_idx').run();
        await partial
          .prepare(
            `CREATE INDEX rdf_quads_pogs_idx ON rdf_quads(
              predicate_key, object_key, graph_key, subject_key
            ) WHERE predicate_key IS NOT NULL`,
          )
          .run();
        await expect(initializeStore(partial)).rejects.toThrow(
          /unexpected index definition|partial|ambiguous/u,
        );
        expect(
          await readAppliedMigrations(partial, diamondMigrationNamespace),
        ).toEqual([]);
      } finally {
        await partial.close();
      }
    });

    it('rejects checksum drift and unknown newer migration IDs', async () => {
      const drifted = await adapter.create();
      try {
        await initializeStore(drifted);
        await drifted
          .prepare(
            `UPDATE ${migrationLedgerTable} SET checksum = 'changed'
             WHERE namespace = ?`,
          )
          .bind(diamondMigrationNamespace)
          .run();
        await expect(initializeStore(drifted)).rejects.toThrow(
          /checksum drift/iu,
        );
      } finally {
        await drifted.close();
      }

      const newer = await adapter.create();
      try {
        await ensureMigrationLedger(newer);
        await newer
          .prepare(
            `INSERT INTO ${migrationLedgerTable}
              (namespace, migration_id, checksum, adopted, applied_at)
             VALUES (?, '9999-future', 'future', 0, ?)`,
          )
          .bind(diamondMigrationNamespace, new Date().toISOString())
          .run();
        await expect(initializeStore(newer)).rejects.toThrow(/unknown|newer/u);
      } finally {
        await newer.close();
      }
    });

    it('rolls back a failed migration and succeeds after correction', async () => {
      const db = await adapter.create();
      try {
        await expect(
          applyNamespacedMigrations(db, '@gnolith/fault-test', [
            {
              id: '0001',
              statements: [
                'CREATE TABLE fault_probe (id INTEGER PRIMARY KEY)',
                'INSERT INTO missing_table VALUES (1)',
              ],
            },
          ]),
        ).rejects.toBeInstanceOf(MigrationStateError);
        const missing = await db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'fault_probe'")
          .all();
        expect(missing.results).toEqual([]);
        expect(await readAppliedMigrations(db, '@gnolith/fault-test')).toEqual(
          [],
        );

        await applyNamespacedMigrations(db, '@gnolith/fault-test', [
          {
            id: '0001',
            statements: ['CREATE TABLE fault_probe (id INTEGER PRIMARY KEY)'],
          },
        ]);
        expect(
          await readAppliedMigrations(db, '@gnolith/fault-test'),
        ).toHaveLength(1);
      } finally {
        await db.close();
      }
    });

    it('converges racing initializers and keeps namespaces independent', async () => {
      const db = await adapter.create();
      try {
        await expect(
          Promise.all([initializeStore(db), initializeStore(db)]),
        ).resolves.toHaveLength(2);
        await applyNamespacedMigrations(db, '@gnolith/other-package', [
          {
            id: '0001',
            statements: [
              'CREATE TABLE other_package_state (value TEXT NOT NULL)',
            ],
          },
        ]);
        expect(
          await readAppliedMigrations(db, diamondMigrationNamespace),
        ).toHaveLength(1);
        expect(
          await readAppliedMigrations(db, '@gnolith/other-package'),
        ).toHaveLength(1);
      } finally {
        await db.close();
      }
    });

    it('rejects malformed ledger, migration inputs, and history gaps', async () => {
      const malformed = await adapter.create();
      try {
        await malformed
          .prepare(
            `CREATE TABLE ${migrationLedgerTable} (namespace TEXT) STRICT`,
          )
          .run();
        await expect(ensureMigrationLedger(malformed)).rejects.toThrow(
          /unsupported schema/u,
        );
      } finally {
        await malformed.close();
      }

      const nonStrict = await adapter.create();
      try {
        await nonStrict
          .prepare(
            `CREATE TABLE ${migrationLedgerTable} (
              namespace TEXT NOT NULL,
              migration_id TEXT NOT NULL,
              checksum TEXT NOT NULL,
              adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
              applied_at TEXT NOT NULL,
              PRIMARY KEY (namespace, migration_id)
            )`,
          )
          .run();
        await expect(ensureMigrationLedger(nonStrict)).rejects.toThrow(
          /exact STRICT/u,
        );
      } finally {
        await nonStrict.close();
      }

      const db = await adapter.create();
      try {
        await expect(applyNamespacedMigrations(db, '', [])).rejects.toThrow(
          /namespace/u,
        );
        await expect(
          applyNamespacedMigrations(db, 'x'.repeat(201), []),
        ).rejects.toThrow(/namespace/u);
        await expect(
          applyNamespacedMigrations(db, '@gnolith/invalid', [
            { id: '', statements: ['SELECT 1'] },
          ]),
        ).rejects.toThrow(/requires an ID/u);
        await expect(
          applyNamespacedMigrations(db, '@gnolith/invalid', [
            { id: '0001', statements: [] },
          ]),
        ).rejects.toThrow(/at least one statement/u);
        await expect(
          applyNamespacedMigrations(db, '@gnolith/invalid', [
            { id: '0001', statements: [' '] },
          ]),
        ).rejects.toThrow(/must not be empty/u);
        await expect(
          applyNamespacedMigrations(db, '@gnolith/invalid', [
            { id: '0002', statements: ['SELECT 2'] },
            { id: '0001', statements: ['SELECT 1'] },
          ]),
        ).rejects.toThrow(/strictly ordered/u);

        const migrations = [
          { id: '0001', statements: ['CREATE TABLE gap_one (id INTEGER)'] },
          { id: '0002', statements: ['CREATE TABLE gap_two (id INTEGER)'] },
        ] as const;
        await ensureMigrationLedger(db);
        await db
          .prepare(
            `INSERT INTO ${migrationLedgerTable}
              (namespace, migration_id, checksum, adopted, applied_at)
             VALUES (?, ?, ?, 0, ?)`,
          )
          .bind(
            '@gnolith/gap-test',
            migrations[1].id,
            await checksumMigration(migrations[1]),
            new Date().toISOString(),
          )
          .run();
        await expect(
          applyNamespacedMigrations(db, '@gnolith/gap-test', migrations),
        ).rejects.toThrow(/partial|out of order/u);
      } finally {
        await db.close();
      }
    });
  });
}
