import { Miniflare } from 'miniflare';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  D1QuadSource,
  QuadPatchConflictError,
  applyQuadPatch,
  insertQuads,
} from '../src/d1-source.js';
import { encodeTerm } from '../src/term-codec.js';
import type { D1DatabaseLike } from '../src/d1-types.js';
import { initializeStore, inspectStoreSchema } from '../src/schema.js';

const factory = new DataFactory();

function collect(stream: RDF.Stream<RDF.Quad>): Promise<RDF.Quad[]> {
  return new Promise((resolve, reject) => {
    const quads: RDF.Quad[] = [];
    stream.on('data', (quad) => quads.push(quad));
    stream.on('end', () => resolve(quads));
    stream.on('error', reject);
  });
}

describe('workerd D1 integration', () => {
  let miniflare: Miniflare;
  let db: D1DatabaseLike;

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'sparql-d1-test' },
    });
    db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
    await initializeStore(db);
  });

  afterAll(async () => miniflare.dispose());

  it('executes schema, atomic writes, and pattern reads through D1', async () => {
    const subject = factory.namedNode('https://example.test/real-d1');
    await insertQuads(db, [
      factory.quad(
        subject,
        factory.namedNode('https://example.test/name'),
        factory.literal('D1'),
      ),
    ]);
    const observations: Array<Record<string, unknown> | undefined> = [];
    const source = new D1QuadSource(db, {
      observe: (observation) => observations.push(observation.metadata),
    });
    await expect(source.countQuads(subject)).resolves.toBe(1);
    await expect(collect(source.match(subject))).resolves.toHaveLength(1);
    expect(observations).toHaveLength(2);
    expect(
      observations.every((metadata) => metadata?.rows_read !== undefined),
    ).toBe(true);
  });

  it('inspects the workerd D1 catalog for strictness and index order', async () => {
    const inspection = await inspectStoreSchema(db);
    expect(inspection.valid, inspection.errors.join('\n')).toBe(true);
    expect(inspection.table.strict).toBe(true);
    expect(Object.keys(inspection.indexes)).toHaveLength(4);
    expect(inspection.indexes).toHaveProperty('sqlite_autoindex_rdf_quads_1');
    expect(inspection.indexes).not.toHaveProperty('rdf_quads_spog_idx');

    const plan = await db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM rdf_quads WHERE subject_key = ?',
      )
      .bind(encodeTerm(factory.namedNode('https://example.test/plan')).key)
      .all<{ detail: string }>();
    expect(plan.results.map(({ detail }) => detail).join('\n')).toContain(
      'sqlite_autoindex_rdf_quads_1',
    );
  });

  it('serializes concurrent duplicate writes without violating set semantics', async () => {
    const quad = factory.quad(
      factory.namedNode('https://example.test/concurrent'),
      factory.namedNode('https://example.test/value'),
      factory.literal('once'),
    );

    const changes = await Promise.all(
      Array.from({ length: 8 }, () => insertQuads(db, [quad])),
    );
    expect(changes.reduce((total, value) => total + value, 0)).toBe(1);
    await expect(new D1QuadSource(db).countQuads(quad.subject)).resolves.toBe(
      1,
    );
  });

  it('rolls back every statement when a D1 batch fails', async () => {
    await expect(
      db.batch([
        db.prepare('CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY)'),
        db.prepare('INSERT INTO table_that_does_not_exist VALUES (1)'),
      ]),
    ).rejects.toThrow();

    const result = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
      )
      .all<{ count: number }>();
    expect(result.results[0]?.count).toBe(0);
  });

  it('rolls back a quad patch when its insert side fails in workerd D1', async () => {
    const oldQuad = factory.quad(
      factory.namedNode('https://example.test/patch-old'),
      factory.namedNode('https://example.test/value'),
      factory.literal('old'),
    );
    const rejectedQuad = factory.quad(
      factory.namedNode('https://example.test/patch-rejected'),
      factory.namedNode('https://example.test/value'),
      factory.literal('new'),
    );
    await insertQuads(db, [oldQuad]);
    await db
      .prepare(
        `CREATE TRIGGER reject_patch_insert
        BEFORE INSERT ON rdf_quads
        WHEN NEW.subject_key = '${encodeTerm(rejectedQuad.subject).key.replaceAll("'", "''")}'
        BEGIN
          SELECT RAISE(ABORT, 'injected patch failure');
        END`,
      )
      .run();

    try {
      await expect(
        applyQuadPatch(db, { delete: [oldQuad], insert: [rejectedQuad] }),
      ).rejects.toThrow(/injected patch failure/);
      const source = new D1QuadSource(db);
      await expect(
        source.countQuads(
          oldQuad.subject,
          oldQuad.predicate,
          oldQuad.object,
          oldQuad.graph,
        ),
      ).resolves.toBe(1);
      await expect(
        source.countQuads(
          rejectedQuad.subject,
          rejectedQuad.predicate,
          rejectedQuad.object,
          rejectedQuad.graph,
        ),
      ).resolves.toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER reject_patch_insert').run();
    }
  });

  it('pages workerd D1 reads and stops fetching after cancellation', async () => {
    const subject = factory.namedNode('https://example.test/paged');
    const pageQuads = Array.from({ length: 5 }, (_, index) =>
      factory.quad(
        subject,
        factory.namedNode(`https://example.test/p${index}`),
        factory.literal(String(index)),
      ),
    );
    await insertQuads(db, pageQuads);
    const observations: number[] = [];
    const source = new D1QuadSource(db, {
      pageSize: 2,
      observe: (observation) =>
        observations.push(Number(observation.metadata?.page)),
    });
    await expect(collect(source.match(subject))).resolves.toHaveLength(5);
    expect(observations).toEqual([1, 2, 3]);

    const cancellationObservations: number[] = [];
    const cancellable = new D1QuadSource(db, {
      pageSize: 2,
      observe: () => cancellationObservations.push(1),
    }).match(subject) as RDF.Stream<RDF.Quad> & { destroy(): void };
    await new Promise<void>((resolve, reject) => {
      cancellable.once('data', () => {
        cancellable.destroy();
        resolve();
      });
      cancellable.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancellationObservations).toHaveLength(1);
  });

  it('allows exactly one concurrent edit for an expected revision', async () => {
    const entity = factory.namedNode('https://example.test/revisioned');
    const predicate = factory.namedNode('https://example.test/revision');
    const oldRevision = factory.quad(entity, predicate, factory.literal('1'));
    const replacements = ['2a', '2b'].map((value) =>
      factory.quad(entity, predicate, factory.literal(value)),
    );
    await insertQuads(db, [oldRevision]);

    const outcomes = await Promise.allSettled(
      replacements.map((replacement) =>
        applyQuadPatch(db, {
          require: [oldRevision],
          delete: [oldRevision],
          insert: [replacement],
        }),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.any(QuadPatchConflictError),
    });
    const source = new D1QuadSource(db);
    await expect(source.countQuads(entity, predicate)).resolves.toBe(1);
    await expect(
      source.countQuads(entity, predicate, oldRevision.object),
    ).resolves.toBe(0);
  });

  it('evaluates require-only patches transactionally in workerd D1', async () => {
    const existing = factory.quad(
      factory.namedNode('https://example.test/asserted'),
      factory.namedNode('https://example.test/value'),
      factory.literal('present'),
    );
    const missing = factory.quad(
      factory.namedNode('https://example.test/asserted'),
      factory.namedNode('https://example.test/value'),
      factory.literal('missing'),
    );
    await insertQuads(db, [existing]);
    await expect(applyQuadPatch(db, { require: [existing] })).resolves.toEqual({
      deleted: 0,
      inserted: 0,
    });
    await expect(
      applyQuadPatch(db, { require: [missing] }),
    ).rejects.toBeInstanceOf(QuadPatchConflictError);
    await expect(applyQuadPatch(db, { forbid: [missing] })).resolves.toEqual({
      deleted: 0,
      inserted: 0,
    });
    await expect(
      applyQuadPatch(db, { forbid: [existing] }),
    ).rejects.toBeInstanceOf(QuadPatchConflictError);
    const guards = await db
      .prepare('SELECT COUNT(*) AS count FROM rdf_patch_guards')
      .all<{ count: number }>();
    expect(guards.results[0]?.count).toBe(0);
  });

  it('allows exactly one concurrent creation guarded by forbidden absence', async () => {
    const entity = factory.namedNode('https://example.test/new-entity');
    const marker = factory.quad(
      entity,
      factory.namedNode('https://example.test/type'),
      factory.namedNode('https://example.test/Entity'),
    );
    const variants = ['a', 'b'].map((value) =>
      factory.quad(
        entity,
        factory.namedNode('https://example.test/value'),
        factory.literal(value),
      ),
    );
    const outcomes = await Promise.allSettled(
      variants.map((variant) =>
        applyQuadPatch(db, { forbid: [marker], insert: [marker, variant] }),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter(({ status }) => status === 'rejected'),
    ).toMatchObject([{ reason: expect.any(QuadPatchConflictError) }]);
    const source = new D1QuadSource(db);
    await expect(source.countQuads(entity)).resolves.toBe(2);
  });
});
