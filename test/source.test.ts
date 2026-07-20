import type * as RDF from '@rdfjs/types';
import { fromArray } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D1QuadSource,
  D1QuadStore,
  MAX_ATOMIC_WRITE_BYTES,
  deleteMatchingQuads,
  insertQuads,
} from '../src/d1-source.js';
import { initializeStore } from '../src/schema.js';
import { MemoryD1 } from './memory-d1.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://example.test/${value}`);

const quads = [
  factory.quad(ex('alice'), ex('knows'), ex('bob')),
  factory.quad(ex('alice'), ex('name'), factory.literal('Alice', 'en')),
  factory.quad(ex('bob'), ex('name'), factory.literal('Bob'), ex('people')),
  factory.quad(ex('carol'), ex('knows'), ex('alice'), ex('people')),
];

async function collect(stream: RDF.Stream<RDF.Quad>): Promise<RDF.Quad[]> {
  return new Promise((resolve, reject) => {
    const values: RDF.Quad[] = [];
    stream.on('data', (quad) => values.push(quad));
    stream.on('end', () => resolve(values));
    stream.on('error', reject);
  });
}

async function completed(emitter: NodeJS.EventEmitter): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.on('end', resolve);
    emitter.on('error', reject);
  });
}

describe('D1QuadSource', () => {
  let db: MemoryD1;
  let source: D1QuadSource;

  beforeEach(async () => {
    db = new MemoryD1();
    await initializeStore(db);
    await insertQuads(db, quads);
    source = new D1QuadSource(db);
  });

  afterEach(() => db.close());

  for (let mask = 0; mask < 16; mask += 1) {
    it(`matches bound-position mask ${mask.toString(2).padStart(4, '0')}`, async () => {
      const target = quads[0]!;
      const pattern: Array<RDF.Term | null> = [
        mask & 8 ? target.subject : null,
        mask & 4 ? target.predicate : null,
        mask & 2 ? target.object : null,
        mask & 1 ? target.graph : null,
      ];
      const expected = quads.filter((quad) =>
        pattern.every((term, index) => {
          const actual = [
            quad.subject,
            quad.predicate,
            quad.object,
            quad.graph,
          ][index]!;
          return term === null || term.equals(actual);
        }),
      );
      const actual = await collect(source.match(...pattern));
      expect(actual).toHaveLength(expected.length);
      expect(
        actual.every((quad) => expected.some((item) => item.equals(quad))),
      ).toBe(true);
      await expect(source.countQuads(...pattern)).resolves.toBe(
        expected.length,
      );
    });
  }

  it('distinguishes the default graph from an unbound graph', async () => {
    await expect(source.countQuads(null, null, null, null)).resolves.toBe(4);
    await expect(
      source.countQuads(null, null, null, factory.defaultGraph()),
    ).resolves.toBe(2);
  });

  it('deduplicates identical quads', async () => {
    await insertQuads(db, [quads[0]!]);
    await expect(source.countQuads()).resolves.toBe(4);
  });

  it('rejects an atomic write before it reaches D1 when its payload exceeds the binding limit', async () => {
    const oversized = factory.quad(
      ex('large'),
      ex('value'),
      factory.literal('x'.repeat(MAX_ATOMIC_WRITE_BYTES)),
    );

    await expect(insertQuads(db, [oversized])).rejects.toThrow(
      /split it at the application boundary/,
    );
    await expect(source.countQuads(oversized.subject)).resolves.toBe(0);
  });

  it('deletes only matching quads', async () => {
    await expect(deleteMatchingQuads(db, ex('alice'))).resolves.toBe(2);
    await expect(source.countQuads()).resolves.toBe(2);
  });

  it('implements transactional RDF/JS Store operations', async () => {
    const store = new D1QuadStore(db);
    const added = factory.quad(ex('dave'), ex('name'), factory.literal('Dave'));
    await completed(store.import(fromArray([added])));
    await expect(store.countQuads(added.subject)).resolves.toBe(1);

    await completed(store.remove(fromArray([added])));
    await expect(store.countQuads(added.subject)).resolves.toBe(0);

    await completed(store.removeMatches(ex('alice'), ex('name')));
    await expect(store.countQuads(ex('alice'), ex('name'))).resolves.toBe(0);
  });

  it('deletes graphs addressed by IRI string or RDF term', async () => {
    const store = new D1QuadStore(db);
    await completed(store.deleteGraph('https://example.test/people'));
    await expect(
      store.countQuads(null, null, null, ex('people')),
    ).resolves.toBe(0);

    const otherGraph = ex('other');
    await insertQuads(db, [
      factory.quad(ex('x'), ex('p'), ex('o'), otherGraph),
    ]);
    await completed(store.deleteGraph(otherGraph));
    await expect(store.countQuads(null, null, null, otherGraph)).resolves.toBe(
      0,
    );
  });

  it('treats empty write streams as successful no-ops', async () => {
    const store = new D1QuadStore(db);
    await completed(store.import(fromArray([])));
    await completed(store.remove(fromArray([])));
    await expect(store.countQuads()).resolves.toBe(4);
  });
});
