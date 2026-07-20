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
});
