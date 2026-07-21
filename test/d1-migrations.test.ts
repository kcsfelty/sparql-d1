import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../src/d1-types.js';
import {
  MigrationStateError,
  applyNamespacedMigrations,
  ensureMigrationLedger,
  migrationLedgerTable,
  readAppliedMigrations,
} from '../src/migrations.js';
import {
  diamondMigrationNamespace,
  initializeStore,
  schemaStatements,
} from '../src/schema.js';

describe('workerd D1 migration conformance', () => {
  let miniflare: Miniflare;
  const databases = new Map<string, D1DatabaseLike>();

  beforeAll(async () => {
    const names = [
      'fresh',
      'legacy',
      'partial',
      'adversarial',
      'ledger',
      'history',
      'failure',
      'race',
    ];
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: Object.fromEntries(names.map((name) => [name, name])),
    });
    for (const name of names) {
      databases.set(
        name,
        (await miniflare.getD1Database(name)) as unknown as D1DatabaseLike,
      );
    }
  });

  afterAll(async () => miniflare.dispose());

  it('migrates empty D1 and repeats without changing history', async () => {
    const db = databases.get('fresh')!;
    await initializeStore(db);
    const first = await readAppliedMigrations(db, diamondMigrationNamespace);
    await initializeStore(db);
    expect(await readAppliedMigrations(db, diamondMigrationNamespace)).toEqual(
      first,
    );
  });

  it('adopts exact legacy D1 without rewriting data', async () => {
    const db = databases.get('legacy')!;
    await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
    await db
      .prepare(
        `INSERT INTO rdf_quads (
          subject_key, subject_json, predicate_key, predicate_json,
          object_key, object_json, graph_key, graph_json
        ) VALUES ('s', '{}', 'p', '{}', 'o', '{}', 'g', '{}')`,
      )
      .run();
    await initializeStore(db);
    expect(
      await readAppliedMigrations(db, diamondMigrationNamespace),
    ).toMatchObject([{ adopted: true }]);
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM rdf_quads')
      .all<{ count: number }>();
    expect(count.results[0]?.count).toBe(1);
  });

  it('rejects partial D1 without destructive repair', async () => {
    const db = databases.get('partial')!;
    await db
      .prepare('CREATE TABLE rdf_quads (id INTEGER PRIMARY KEY) STRICT')
      .run();
    await expect(initializeStore(db)).rejects.toThrow(/partial|ambiguous/u);
    expect(await readAppliedMigrations(db, diamondMigrationNamespace)).toEqual(
      [],
    );
  });

  it('rejects unrelated-name D1 trigger targeting Diamond during adoption', async () => {
    const db = databases.get('adversarial')!;
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
  });

  it('rejects a matching but non-STRICT D1 ledger', async () => {
    const db = databases.get('ledger')!;
    await db
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
    await expect(ensureMigrationLedger(db)).rejects.toThrow(/exact STRICT/u);
  });

  it('rejects drift and unknown D1 history', async () => {
    const db = databases.get('history')!;
    await initializeStore(db);
    await db
      .prepare(
        `UPDATE ${migrationLedgerTable} SET checksum = 'changed'
         WHERE namespace = ?`,
      )
      .bind(diamondMigrationNamespace)
      .run();
    await expect(initializeStore(db)).rejects.toThrow(/checksum drift/iu);
    await db
      .prepare(
        `UPDATE ${migrationLedgerTable} SET migration_id = '9999-future'
         WHERE namespace = ?`,
      )
      .bind(diamondMigrationNamespace)
      .run();
    await expect(initializeStore(db)).rejects.toThrow(/unknown|newer/u);
  });

  it('rolls back failed D1 migration and accepts a correction', async () => {
    const db = databases.get('failure')!;
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
    const table = await db
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'fault_probe'")
      .all();
    expect(table.results).toEqual([]);
    await applyNamespacedMigrations(db, '@gnolith/fault-test', [
      {
        id: '0001',
        statements: ['CREATE TABLE fault_probe (id INTEGER PRIMARY KEY)'],
      },
    ]);
  });

  it('converges concurrent D1 initialization and isolates namespaces', async () => {
    const db = databases.get('race')!;
    await expect(
      Promise.all([initializeStore(db), initializeStore(db)]),
    ).resolves.toHaveLength(2);
    await ensureMigrationLedger(db);
    await applyNamespacedMigrations(db, '@gnolith/other-package', [
      {
        id: '0001',
        statements: ['CREATE TABLE other_state (value TEXT NOT NULL)'],
      },
    ]);
    expect(
      await readAppliedMigrations(db, diamondMigrationNamespace),
    ).toHaveLength(1);
    expect(
      await readAppliedMigrations(db, '@gnolith/other-package'),
    ).toHaveLength(1);
  });
});
