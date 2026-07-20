import assert from 'node:assert/strict';
import { DataFactory } from 'rdf-data-factory';
import {
  D1QuadSource,
  QuadPatchConflictError,
  createSparqlHandler,
  initializeStore,
} from 'sparql-d1';
import {
  createWikibaseStyleEntity,
  createWikibaseStyleVocabulary,
  deleteWikibaseStyleEntity,
  replaceWikibaseStyleEntity,
  setWikibaseStyleStatementRank,
  type ExampleEntityDocument,
} from '../examples/codex-site/wikibase-style-statements.js';
import { MemoryD1 } from '../test/memory-d1.js';

const factory = new DataFactory();
const vocabulary = createWikibaseStyleVocabulary('https://site.test/rdf');
const db = new MemoryD1();

const before: ExampleEntityDocument = {
  entityId: 'Q1',
  revision: 1,
  statements: [
    {
      id: 'Q1-S1',
      property: 'P1',
      value: { kind: 'value', value: vocabulary.entity('Q2') },
      rank: 'normal',
      qualifiers: [
        {
          property: 'P2',
          snak: { kind: 'value', value: factory.literal('old qualifier') },
        },
      ],
      references: [
        {
          id: 'R1',
          snaks: [
            {
              property: 'P3',
              snak: {
                kind: 'value',
                value: factory.namedNode('https://source.test/one'),
              },
            },
          ],
        },
      ],
    },
  ],
};

const quantityNode = factory.namedNode(
  'https://site.test/rdf/value/quantity-7',
);
const after: ExampleEntityDocument = {
  entityId: 'Q1',
  revision: 2,
  statements: [
    {
      id: 'Q1-S1',
      property: 'P1',
      value: { kind: 'value', value: vocabulary.entity('Q2') },
      rank: 'deprecated',
    },
    {
      id: 'Q1-S2',
      property: 'P1',
      value: {
        kind: 'value',
        value: factory.literal('7'),
        fullValue: {
          node: quantityNode,
          quads: [
            factory.quad(
              quantityNode,
              factory.namedNode('https://site.test/rdf/schema/amount'),
              factory.literal('7'),
            ),
          ],
        },
      },
      rank: 'preferred',
      qualifiers: [
        { property: 'P4', snak: { kind: 'somevalue' } },
        { property: 'P5', snak: { kind: 'novalue' } },
      ],
      references: [
        {
          id: 'R2',
          snaks: [
            {
              property: 'P3',
              snak: {
                kind: 'value',
                value: factory.namedNode('https://source.test/two'),
              },
            },
            {
              property: 'P6',
              snak: { kind: 'value', value: factory.literal('page 3') },
            },
          ],
        },
      ],
    },
    {
      id: 'Q1-S3',
      property: 'P7',
      value: { kind: 'value', value: factory.literal('other property') },
      rank: 'normal',
    },
  ],
};

try {
  await initializeStore(db);
  await createWikibaseStyleEntity(db, vocabulary, before);
  await assert.doesNotReject(
    replaceWikibaseStyleEntity(db, vocabulary, before, after, 1),
  );

  await assert.rejects(
    replaceWikibaseStyleEntity(db, vocabulary, before, after, 1),
    QuadPatchConflictError,
  );

  const source = new D1QuadSource(db);
  assert.equal(
    await source.countQuads(
      vocabulary.entity('Q1'),
      vocabulary.revision,
      factory.literal(
        '2',
        factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
      ),
    ),
    1,
  );
  assert.equal(
    await source.countQuads(
      vocabulary.entity('Q1'),
      vocabulary.direct('P1'),
      factory.literal('7'),
    ),
    1,
  );
  assert.equal(
    await source.countQuads(
      vocabulary.entity('Q1'),
      vocabulary.direct('P1'),
      vocabulary.entity('Q2'),
    ),
    0,
  );
  assert.equal(
    await source.countQuads(
      vocabulary.entity('Q1'),
      vocabulary.direct('P7'),
      factory.literal('other property'),
    ),
    1,
  );

  const handle = createSparqlHandler({ db, exposeErrors: true });
  const response = await handle(
    new Request('https://site.test/api/sparql', {
      method: 'POST',
      headers: {
        accept: 'application/sparql-results+json',
        'content-type': 'application/sparql-query',
      },
      body: `SELECT ?statement ?qualifier ?referenceValue ?amount WHERE {
        <${vocabulary.entity('Q1').value}> <${vocabulary.claim('P1').value}> ?statement.
        ?statement a <http://wikiba.se/ontology#BestRank>;
          <${vocabulary.qualifier('P4').value}> ?qualifier;
          <http://www.w3.org/ns/prov#wasDerivedFrom> ?reference;
          <${vocabulary.statementFullValue('P1').value}> ?fullValue.
        ?reference <${vocabulary.referenceValue('P3').value}> ?referenceValue.
        ?fullValue <https://site.test/rdf/schema/amount> ?amount.
      }`,
    }),
  );
  if (response.status !== 200) {
    assert.fail(`SPARQL example request failed: ${await response.text()}`);
  }
  const result = (await response.json()) as {
    results: { bindings: Array<Record<string, { value: string }>> };
  };
  assert.equal(result.results.bindings.length, 1);
  assert.equal(
    result.results.bindings[0]?.referenceValue?.value,
    'https://source.test/two',
  );
  assert.equal(result.results.bindings[0]?.amount?.value, '7');
  assert.match(
    result.results.bindings[0]?.qualifier?.value ?? '',
    /special\/somevalue/,
  );

  await setWikibaseStyleStatementRank(
    db,
    vocabulary,
    after,
    'Q1-S2',
    'normal',
    2,
  );
  const revisionThree: ExampleEntityDocument = {
    ...after,
    revision: 3,
    statements: [...after.statements].map((statement) =>
      statement.id === 'Q1-S2' ? { ...statement, rank: 'normal' } : statement,
    ),
  };
  assert.equal(
    await source.countQuads(
      vocabulary.statement('Q1-S2'),
      factory.namedNode('http://wikiba.se/ontology#rank'),
      factory.namedNode('http://wikiba.se/ontology#NormalRank'),
    ),
    1,
  );
  await deleteWikibaseStyleEntity(db, vocabulary, revisionThree, 3);
  assert.equal(
    await source.countQuads(vocabulary.entity('Q1'), null, null, null),
    0,
  );

  process.stdout.write('Wikibase-style application example passed.\n');
} finally {
  db.close();
}
