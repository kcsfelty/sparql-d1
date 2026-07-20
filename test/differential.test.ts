import type * as RDF from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { DataFactory } from 'rdf-data-factory';
import { Store } from 'n3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import { initializeStore } from '../src/schema.js';
import { encodeTerm } from '../src/term-codec.js';
import { MemoryD1 } from './memory-d1.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://example.test/${value}`);
const dataset = [
  factory.quad(ex('alice'), ex('type'), ex('Person')),
  factory.quad(ex('alice'), ex('name'), factory.literal('Alice')),
  factory.quad(ex('alice'), ex('knows'), ex('bob')),
  factory.quad(ex('bob'), ex('type'), ex('Person')),
  factory.quad(ex('bob'), ex('name'), factory.literal('Bob')),
  factory.quad(ex('carol'), ex('name'), factory.literal('Carol'), ex('people')),
];

function canonicalTerm(term: RDF.Term): string {
  return encodeTerm(term).key;
}

async function bindingsFor(
  query: string,
  source: RDF.Source,
): Promise<string[]> {
  const engine = new QueryEngine();
  const stream = await engine.queryBindings(query, { sources: [source] });
  const bindings = await stream.toArray();
  return bindings
    .map((binding) =>
      [...binding]
        .map(([variable, term]) => `${variable.value}=${canonicalTerm(term)}`)
        .sort()
        .join('|'),
    )
    .sort();
}

describe('Comunica differential behavior', () => {
  let db: MemoryD1;
  let d1Source: D1QuadSource;
  let reference: Store;

  beforeEach(async () => {
    db = new MemoryD1();
    await initializeStore(db);
    await insertQuads(db, dataset);
    d1Source = new D1QuadSource(db);
    reference = new Store(dataset);
  });

  afterEach(() => db.close());

  const queries = [
    `SELECT * WHERE { ?s ?p ?o }`,
    `SELECT ?name WHERE {
      ?person <https://example.test/type> <https://example.test/Person>;
              <https://example.test/name> ?name.
    } ORDER BY ?name`,
    `SELECT ?person ?name WHERE {
      ?person <https://example.test/type> <https://example.test/Person>.
      OPTIONAL { ?person <https://example.test/name> ?name }
    }`,
    `SELECT (COUNT(?person) AS ?count) WHERE {
      ?person <https://example.test/type> <https://example.test/Person>
    }`,
    `SELECT ?person WHERE {
      { ?person <https://example.test/name> "Alice" }
      UNION
      { ?person <https://example.test/name> "Bob" }
    }`,
    `SELECT ?graph ?person WHERE {
      GRAPH ?graph { ?person <https://example.test/name> "Carol" }
    }`,
  ];

  it.each(queries)('matches the in-memory reference for %#', async (query) => {
    await expect(bindingsFor(query, d1Source)).resolves.toEqual(
      await bindingsFor(query, reference),
    );
  });
});
