import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expectedStoreIndexes,
  initializeStore,
  inspectStoreSchema,
} from '../src/schema.js';
import { MemoryD1 } from './memory-d1.js';

describe('store schema inspection', () => {
  let db: MemoryD1;

  beforeEach(() => {
    db = new MemoryD1();
  });

  afterEach(() => db.close());

  it('verifies the strict table and every covering index in catalog order', async () => {
    await initializeStore(db);
    await expect(inspectStoreSchema(db)).resolves.toEqual({
      table: {
        name: 'rdf_quads',
        sql: expect.stringMatching(/\)\s*STRICT$/u),
        strict: true,
      },
      guardTable: {
        name: 'rdf_patch_guards',
        sql: expect.stringMatching(/\)\s*STRICT$/u),
        strict: true,
      },
      indexes: expectedStoreIndexes,
      valid: true,
      errors: [],
    });
  });

  it('reports missing and malformed catalog objects', async () => {
    const missing = await inspectStoreSchema(db);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain('rdf_quads table is missing');
    expect(missing.errors).toContain('rdf_patch_guards table is missing');

    await initializeStore(db);
    await db.prepare('DROP INDEX rdf_quads_pogs_idx').run();
    const malformed = await inspectStoreSchema(db);
    expect(malformed.valid).toBe(false);
    expect(malformed.errors).toContain(
      'rdf_quads_pogs_idx has columns [], expected [predicate_key, object_key, graph_key, subject_key]',
    );
  });

  it('rejects unexpected indexes, views, and unrelated-name triggers', async () => {
    await initializeStore(db);
    await db
      .prepare('CREATE INDEX surprise_idx ON rdf_quads(subject_json)')
      .run();
    await expect(inspectStoreSchema(db)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/surprise_idx/u)]),
    });
    await db.prepare('DROP INDEX surprise_idx').run();

    await db
      .prepare('CREATE VIEW harmless_view AS SELECT * FROM rdf_quads')
      .run();
    await expect(inspectStoreSchema(db)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/harmless_view/u)]),
    });
    await db.prepare('DROP VIEW harmless_view').run();

    await db.prepare('CREATE TABLE unrelated (value INTEGER)').run();
    await db
      .prepare(
        `CREATE TRIGGER innocuous_name AFTER INSERT ON unrelated BEGIN
           DELETE FROM rdf_quads WHERE id = NEW.value;
         END`,
      )
      .run();
    await expect(inspectStoreSchema(db)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/innocuous_name/u),
      ]),
    });
  });

  it('requires expected indexes to target rdf_quads with exact DDL', async () => {
    await initializeStore(db);
    await db.prepare('DROP INDEX rdf_quads_pogs_idx').run();
    await db
      .prepare(
        `CREATE TABLE unrelated_index_target (
          predicate_key TEXT NOT NULL,
          object_key TEXT NOT NULL,
          graph_key TEXT NOT NULL,
          subject_key TEXT NOT NULL
        ) STRICT`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX rdf_quads_pogs_idx ON unrelated_index_target(
          predicate_key, object_key, graph_key, subject_key
        )`,
      )
      .run();
    await expect(inspectStoreSchema(db)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/belongs to unrelated_index_target/u),
      ]),
    });

    await db.prepare('DROP INDEX rdf_quads_pogs_idx').run();
    await db
      .prepare(
        `CREATE INDEX rdf_quads_pogs_idx ON rdf_quads(
          predicate_key, object_key, graph_key, subject_key
        ) WHERE predicate_key IS NOT NULL`,
      )
      .run();
    await expect(inspectStoreSchema(db)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'rdf_quads_pogs_idx has an unexpected index definition',
      ]),
    });
  });
});
