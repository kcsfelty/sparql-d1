import { expect, it } from 'vitest';
import type { SqliteDatabaseLike } from '../src/d1-types.js';
import {
  MigrationStateError,
  applyNamespacedMigrations,
  migrationLedgerTable,
  readAppliedMigrations,
} from '../src/migrations.js';
import { readSqliteBytes } from '../src/sqlite-values.js';

export interface SqliteCapabilityHarness {
  /** Distinct contenders when the runtime supports multiple connections. */
  claimers: readonly SqliteDatabaseLike[];
  db: SqliteDatabaseLike;
  /** Close every live connection and reopen the same persisted database. */
  reopen(): Promise<SqliteDatabaseLike>;
  close(): Promise<void>;
}

export interface SqliteCapabilityConformanceOptions {
  createHarness(): Promise<SqliteCapabilityHarness>;
  /** The native row representation, recorded to make runtime drift visible. */
  blobRowShape: 'byte-array' | 'typed-array';
  /** D1 rejects bigint bindings; native SQLite preserves them losslessly. */
  largeIntegerBehavior: 'preserve-bigint' | 'reject-bigint';
}

interface ClaimRow {
  id: number;
  revision: number;
  owner: string;
}

interface ValueRow {
  text_value: string;
  integer_value: number;
  real_value: number;
  null_value: null;
  blob_value: unknown;
}

/**
 * Shared evidence for low-level SQL capabilities relied on by package-owned
 * persistence adapters. This deliberately contains no search-domain policy.
 */
export function sqliteCapabilityConformance(
  options: SqliteCapabilityConformanceOptions,
): void {
  it('allows exactly one conditional UPDATE RETURNING claimant', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db
        .prepare(
          `CREATE TABLE capability_claim (
            id INTEGER PRIMARY KEY,
            revision INTEGER NOT NULL,
            owner TEXT
          )`,
        )
        .run();
      await harness.db
        .prepare(
          'INSERT INTO capability_claim (id, revision, owner) VALUES (1, 1, NULL)',
        )
        .run();

      const attempts = await Promise.all(
        harness.claimers.map((db, index) =>
          db
            .prepare(
              `UPDATE capability_claim
               SET owner = ?, revision = revision + 1
               WHERE id = 1 AND revision = ? AND owner IS NULL
               RETURNING id, revision, owner`,
            )
            .bind(`claimer-${index}`, 1)
            .all<ClaimRow>(),
        ),
      );

      const winners = attempts.filter((result) => result.results.length === 1);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({
        results: [{ id: 1, revision: 2 }],
        meta: { changes: 1 },
      });
      expect(
        attempts.reduce(
          (changes, result) => changes + Number(result.meta?.changes ?? 0),
          0,
        ),
      ).toBe(1);
      expect(
        attempts.filter((result) => result.results.length === 0),
      ).toHaveLength(harness.claimers.length - 1);

      const stale = await harness.db
        .prepare(
          `UPDATE capability_claim
           SET owner = ?, revision = revision + 1
           WHERE id = 1 AND revision = ?
           RETURNING id, revision, owner`,
        )
        .bind('stale-claimer', 1)
        .all<ClaimRow>();
      expect(stale).toMatchObject({ results: [], meta: { changes: 0 } });
    } finally {
      await harness.close();
    }
  });

  it('round-trips scalar and BLOB bindings with explicit byte normalization', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db
        .prepare(
          `CREATE TABLE capability_values (
            text_value TEXT NOT NULL,
            integer_value INTEGER NOT NULL,
            real_value REAL NOT NULL,
            null_value TEXT,
            blob_value BLOB NOT NULL
          )`,
        )
        .run();
      const input = Uint8Array.from([0, 1, 127, 128, 255]);
      const boundBuffer = input.buffer.slice(
        input.byteOffset,
        input.byteOffset + input.byteLength,
      );
      await harness.db
        .prepare('INSERT INTO capability_values VALUES (?, ?, ?, ?, ?)')
        .bind('héllo 🌱', 42, 3.25, null, boundBuffer)
        .run();

      const result = await harness.db
        .prepare('SELECT * FROM capability_values')
        .all<ValueRow>();
      expect(result.results).toHaveLength(1);
      const row = result.results[0]!;
      expect(row).toMatchObject({
        text_value: 'héllo 🌱',
        integer_value: 42,
        real_value: 3.25,
        null_value: null,
      });
      expect(Array.isArray(row.blob_value) ? 'byte-array' : 'typed-array').toBe(
        options.blobRowShape,
      );
      expect([...readSqliteBytes(row.blob_value)]).toEqual([...input]);
    } finally {
      await harness.close();
    }
  });

  it('never silently rounds an integer outside the safe-number range', async () => {
    const harness = await options.createHarness();
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    try {
      await harness.db
        .prepare('CREATE TABLE capability_integers (value INTEGER NOT NULL)')
        .run();
      if (options.largeIntegerBehavior === 'reject-bigint') {
        expect(() =>
          harness.db
            .prepare('INSERT INTO capability_integers VALUES (?)')
            .bind(value),
        ).toThrow(/bigint|bind|type|unsupported/iu);
        return;
      }
      const insert = harness.db
        .prepare('INSERT INTO capability_integers VALUES (?)')
        .bind(value)
        .run();
      await expect(insert).resolves.toMatchObject({ meta: { changes: 1 } });
      const result = await harness.db
        .prepare('SELECT value FROM capability_integers')
        .all<{ value: bigint }>();
      expect(result.results).toEqual([{ value }]);
    } finally {
      await harness.close();
    }
  });

  it('returns ordered positional batch results and stable mutation metadata', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db
        .prepare(
          'CREATE TABLE capability_batch (id INTEGER PRIMARY KEY, value TEXT)',
        )
        .run();
      const results = await harness.db.batch<{ id: number; value: string }>([
        harness.db
          .prepare(
            'INSERT INTO capability_batch VALUES (1, ?) RETURNING id, value',
          )
          .bind('first'),
        harness.db
          .prepare(
            'UPDATE capability_batch SET value = ? WHERE id = 1 RETURNING id, value',
          )
          .bind('second'),
        harness.db.prepare('SELECT id, value FROM capability_batch'),
      ]);
      expect(results).toHaveLength(3);
      expect(results).toMatchObject([
        { results: [{ id: 1, value: 'first' }], meta: { changes: 1 } },
        { results: [{ id: 1, value: 'second' }], meta: { changes: 1 } },
        { results: [{ id: 1, value: 'second' }] },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('rolls back when any statement boundary fails', async () => {
    for (const failingIndex of [0, 1, 2]) {
      const harness = await options.createHarness();
      try {
        await harness.db
          .prepare('CREATE TABLE rollback_probe (value INTEGER PRIMARY KEY)')
          .run();
        const statements = [0, 1, 2].map((index) =>
          index === failingIndex
            ? harness.db.prepare('INSERT INTO missing_table VALUES (1)')
            : harness.db
                .prepare('INSERT INTO rollback_probe VALUES (?)')
                .bind(index),
        );
        await expect(harness.db.batch(statements)).rejects.toThrow(
          /missing_table/iu,
        );
        const rows = await harness.db
          .prepare('SELECT value FROM rollback_probe')
          .all();
        expect(rows.results).toEqual([]);
      } finally {
        await harness.close();
      }
    }
  });

  it('rolls back a deferred foreign-key failure raised by commit', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db.batch([
        harness.db.prepare(
          'CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)',
        ),
        harness.db.prepare(
          `CREATE TABLE commit_child (
            parent_id INTEGER REFERENCES commit_parent(id)
              DEFERRABLE INITIALLY DEFERRED
          )`,
        ),
      ]);
      await expect(
        harness.db.batch([
          harness.db.prepare('INSERT INTO commit_child VALUES (99)'),
        ]),
      ).rejects.toThrow(/foreign key|constraint/iu);
      const rows = await harness.db
        .prepare('SELECT parent_id FROM commit_child')
        .all();
      expect(rows.results).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('serializes concurrent calls without losing writes', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db
        .prepare('CREATE TABLE concurrent_probe (value INTEGER PRIMARY KEY)')
        .run();
      await expect(
        Promise.all(
          Array.from({ length: 20 }, (_, value) =>
            harness.db.batch([
              harness.db
                .prepare('INSERT INTO concurrent_probe VALUES (?)')
                .bind(value),
              harness.db.prepare(
                'SELECT COUNT(*) AS count FROM concurrent_probe',
              ),
            ]),
          ),
        ),
      ).resolves.toHaveLength(20);
      const count = await harness.db
        .prepare('SELECT COUNT(*) AS count FROM concurrent_probe')
        .all<{ count: number }>();
      expect(count.results).toEqual([{ count: 20 }]);
    } finally {
      await harness.close();
    }
  });

  it('persists values and BLOBs after every connection is closed and reopened', async () => {
    const harness = await options.createHarness();
    try {
      await harness.db
        .prepare('CREATE TABLE reopen_probe (value TEXT, bytes BLOB)')
        .run();
      await harness.db
        .prepare('INSERT INTO reopen_probe VALUES (?, ?)')
        .bind('durable', Uint8Array.from([3, 1, 4]).buffer)
        .run();
      const reopened = await harness.reopen();
      const row = await reopened
        .prepare('SELECT value, bytes FROM reopen_probe')
        .all<{ value: string; bytes: unknown }>();
      expect(row.results[0]?.value).toBe('durable');
      expect([...readSqliteBytes(row.results[0]?.bytes)]).toEqual([3, 1, 4]);
    } finally {
      await harness.close();
    }
  });

  it('recovers interrupted migrations and refuses checksum drift', async () => {
    const harness = await options.createHarness();
    const namespace = '@gnolith/sqlite-conformance';
    try {
      await expect(
        applyNamespacedMigrations(harness.db, namespace, [
          {
            id: '0001',
            statements: [
              'CREATE TABLE interrupted_probe (value INTEGER)',
              'INSERT INTO missing_table VALUES (1)',
            ],
          },
        ]),
      ).rejects.toBeInstanceOf(MigrationStateError);
      expect(await readAppliedMigrations(harness.db, namespace)).toEqual([]);
      await applyNamespacedMigrations(harness.db, namespace, [
        {
          id: '0001',
          statements: ['CREATE TABLE interrupted_probe (value INTEGER)'],
        },
      ]);
      expect(await readAppliedMigrations(harness.db, namespace)).toHaveLength(
        1,
      );
      await harness.db
        .prepare(
          `UPDATE ${migrationLedgerTable} SET checksum = 'drifted'
           WHERE namespace = ?`,
        )
        .bind(namespace)
        .run();
      await expect(
        applyNamespacedMigrations(harness.db, namespace, [
          {
            id: '0001',
            statements: ['CREATE TABLE interrupted_probe (value INTEGER)'],
          },
        ]),
      ).rejects.toThrow(/checksum drift/iu);
    } finally {
      await harness.close();
    }
  });
}
