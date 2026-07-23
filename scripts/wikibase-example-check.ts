import assert from 'node:assert/strict';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import {
  D1QuadSource,
  QuadPatchConflictError,
  initializeStore,
} from '@gnolith/diamond';
import { createSparqlExecutor } from '@gnolith/diamond/sparql';
import {
  addWikibaseStyleStatement,
  buildWikibaseStyleEntityQuads,
  createWikibaseStyleEntity,
  createWikibaseStyleVocabulary,
  deleteWikibaseStyleEntity,
  deleteWikibaseStyleStatement,
  replaceWikibaseStyleEntity,
  setWikibaseStyleStatementRank,
  type ExampleEntityDocument,
} from '../examples/wikibase-style-statements.js';
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
  assert.notEqual(
    vocabulary.statement('Q1', 'shared-id').value,
    vocabulary.statement('Q2', 'shared-id').value,
  );
  const duplicateStatement = [...before.statements][0]!;
  assert.throws(
    () =>
      buildWikibaseStyleEntityQuads(vocabulary, {
        entityId: 'duplicate-test',
        revision: 1,
        statements: [duplicateStatement, duplicateStatement],
      }),
    /duplicate statement id/,
  );
  assert.throws(
    () =>
      buildWikibaseStyleEntityQuads(vocabulary, {
        entityId: 'duplicate-reference-test',
        revision: 1,
        statements: [
          {
            id: 'statement',
            property: 'P1',
            value: { kind: 'value', value: factory.literal('value') },
            rank: 'normal',
            references: [
              { id: 'same-reference', snaks: [] },
              { id: 'same-reference', snaks: [] },
            ],
          },
        ],
      }),
    /duplicate reference id/,
  );
  const rankQuads = buildWikibaseStyleEntityQuads(vocabulary, {
    entityId: 'rank-test',
    revision: 1,
    statements: [
      {
        id: 'preferred',
        property: 'P8',
        value: { kind: 'value', value: factory.literal('preferred') },
        rank: 'preferred',
      },
      {
        id: 'normal-shadowed',
        property: 'P8',
        value: { kind: 'value', value: factory.literal('normal-shadowed') },
        rank: 'normal',
      },
      {
        id: 'deprecated-shadowed',
        property: 'P8',
        value: { kind: 'value', value: factory.literal('deprecated-shadowed') },
        rank: 'deprecated',
      },
      {
        id: 'normal',
        property: 'P9',
        value: { kind: 'value', value: factory.literal('normal') },
        rank: 'normal',
      },
      {
        id: 'deprecated-with-normal',
        property: 'P9',
        value: {
          kind: 'value',
          value: factory.literal('deprecated-with-normal'),
        },
        rank: 'deprecated',
      },
      {
        id: 'deprecated-only',
        property: 'P10',
        value: { kind: 'value', value: factory.literal('deprecated-only') },
        rank: 'deprecated',
      },
    ],
  });
  const rankEntity = vocabulary.entity('rank-test');
  const bestRankType = factory.namedNode('http://wikiba.se/ontology#BestRank');
  const rdfType = factory.namedNode(
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  );
  const countRankQuads = (
    subject: RDF.Term,
    predicate: RDF.Term,
    object?: RDF.Term,
  ) =>
    rankQuads.filter(
      (quad) =>
        quad.subject.equals(subject) &&
        quad.predicate.equals(predicate) &&
        (object === undefined || quad.object.equals(object)),
    ).length;
  assert.equal(
    countRankQuads(
      rankEntity,
      vocabulary.direct('P8'),
      factory.literal('preferred'),
    ),
    1,
  );
  assert.equal(
    countRankQuads(
      rankEntity,
      vocabulary.direct('P8'),
      factory.literal('normal-shadowed'),
    ),
    0,
  );
  assert.equal(
    countRankQuads(
      vocabulary.statement('rank-test', 'preferred'),
      rdfType,
      bestRankType,
    ),
    1,
  );
  assert.equal(
    countRankQuads(
      vocabulary.statement('rank-test', 'normal-shadowed'),
      rdfType,
      bestRankType,
    ),
    0,
  );
  assert.equal(
    countRankQuads(
      rankEntity,
      vocabulary.direct('P9'),
      factory.literal('normal'),
    ),
    1,
  );
  assert.equal(
    countRankQuads(
      vocabulary.statement('rank-test', 'normal'),
      rdfType,
      bestRankType,
    ),
    1,
  );
  assert.equal(
    countRankQuads(
      vocabulary.statement('rank-test', 'deprecated-with-normal'),
      rdfType,
      bestRankType,
    ),
    0,
  );
  assert.equal(countRankQuads(rankEntity, vocabulary.direct('P10')), 0);
  assert.equal(
    countRankQuads(
      vocabulary.statement('rank-test', 'deprecated-only'),
      rdfType,
      bestRankType,
    ),
    0,
  );
  assert.equal(countRankQuads(rankEntity, vocabulary.claim('P10')), 1);
  await createWikibaseStyleEntity(db, vocabulary, before);
  await assert.rejects(
    createWikibaseStyleEntity(db, vocabulary, before),
    QuadPatchConflictError,
  );
  const otherEntity: ExampleEntityDocument = {
    entityId: 'Q2',
    revision: 1,
    statements: [
      {
        id: 'Q1-S1',
        property: 'P1',
        value: { kind: 'value', value: factory.literal('independent') },
        rank: 'normal',
      },
    ],
  };
  await createWikibaseStyleEntity(db, vocabulary, otherEntity);
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

  const execution = await createSparqlExecutor({ db })({
    operation: 'query',
    accept: 'application/sparql-results+json',
    text: `SELECT ?statement ?qualifier ?referenceValue ?amount WHERE {
        <${vocabulary.entity('Q1').value}> <${vocabulary.claim('P1').value}> ?statement.
        ?statement a <http://wikiba.se/ontology#Statement>, <http://wikiba.se/ontology#BestRank>;
          <${vocabulary.qualifier('P4').value}> ?qualifier;
          <http://www.w3.org/ns/prov#wasDerivedFrom> ?reference;
          <${vocabulary.statementFullValue('P1').value}> ?fullValue.
        ?qualifier a <${vocabulary.someValueType.value}>.
        ?reference a <http://wikiba.se/ontology#Reference>;
          <${vocabulary.referenceValue('P3').value}> ?referenceValue.
        ?fullValue <https://site.test/rdf/schema/amount> ?amount.
      }`,
  });
  const response = new Response(execution.body, {
    status: execution.status,
  });
  if (execution.status !== 200) {
    assert.fail(`SPARQL example execution failed: ${await response.text()}`);
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

  await deleteWikibaseStyleStatement(db, vocabulary, after, 'Q1-S2', 2);
  const revisionThree: ExampleEntityDocument = {
    ...after,
    revision: 3,
    statements: [...after.statements].filter(({ id }) => id !== 'Q1-S2'),
  };
  assert.equal(
    await source.countQuads(vocabulary.entity('Q1'), vocabulary.direct('P1')),
    0,
  );
  assert.equal(
    await source.countQuads(
      vocabulary.statement('Q1', 'Q1-S1'),
      factory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      factory.namedNode('http://wikiba.se/ontology#BestRank'),
    ),
    0,
  );
  const addedStatement = {
    id: 'Q1-S4',
    property: 'P1',
    value: { kind: 'value' as const, value: factory.literal('restored') },
    rank: 'normal' as const,
  };
  await addWikibaseStyleStatement(
    db,
    vocabulary,
    revisionThree,
    addedStatement,
    3,
  );
  const revisionFour: ExampleEntityDocument = {
    ...revisionThree,
    revision: 4,
    statements: [...revisionThree.statements, addedStatement],
  };
  await setWikibaseStyleStatementRank(
    db,
    vocabulary,
    revisionFour,
    'Q1-S4',
    'preferred',
    4,
  );
  const revisionFive: ExampleEntityDocument = {
    ...revisionFour,
    revision: 5,
    statements: [...revisionFour.statements].map((statement) =>
      statement.id === 'Q1-S4'
        ? { ...statement, rank: 'preferred' as const }
        : statement,
    ),
  };
  await deleteWikibaseStyleEntity(db, vocabulary, revisionFive, 5);
  assert.equal(
    await source.countQuads(
      vocabulary.statement('Q2', 'Q1-S1'),
      null,
      null,
      null,
    ),
    4,
  );
  await deleteWikibaseStyleEntity(db, vocabulary, otherEntity, 1);
  assert.equal(await source.countQuads(), 0);

  process.stdout.write('Wikibase-style application example passed.\n');
} finally {
  db.close();
}
