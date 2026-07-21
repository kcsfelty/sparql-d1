import { expect, it } from 'vitest';
import type { SqliteDatabaseLike } from '../src/d1-types.js';
import { readSqliteBytes } from '../src/sqlite-values.js';

export interface SqliteCapabilityHarness {
  /** Distinct contenders when the runtime supports multiple connections. */
  claimers: readonly SqliteDatabaseLike[];
  db: SqliteDatabaseLike;
  close(): Promise<void>;
}

export interface SqliteCapabilityConformanceOptions {
  createHarness(): Promise<SqliteCapabilityHarness>;
  /** The native row representation, recorded to make runtime drift visible. */
  blobRowShape: 'byte-array' | 'typed-array';
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
}
