import { Miniflare } from 'miniflare';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import type { D1DatabaseLike } from '../src/d1-types.js';
import { initializeStore } from '../src/schema.js';

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
});
