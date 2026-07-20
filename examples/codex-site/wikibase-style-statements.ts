import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { applyQuadPatch } from 'sparql-d1';
import type { D1DatabaseLike, QuadPatchResult } from 'sparql-d1';

const factory = new DataFactory();
const RDF_TYPE = factory.namedNode(
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
);
const XSD_INTEGER = factory.namedNode(
  'http://www.w3.org/2001/XMLSchema#integer',
);
const PROV_DERIVED_FROM = factory.namedNode(
  'http://www.w3.org/ns/prov#wasDerivedFrom',
);
const WIKIBASE = 'http://wikiba.se/ontology#';

export type StatementRank = 'preferred' | 'normal' | 'deprecated';

export type ExampleSnak =
  | {
      kind: 'value';
      value: RDF.Term;
      fullValue?: { node: RDF.Term; quads: Iterable<RDF.Quad> };
    }
  | { kind: 'somevalue' }
  | { kind: 'novalue' };

export interface ExamplePropertySnak {
  property: string;
  snak: ExampleSnak;
}

export interface ExampleReference {
  id: string;
  snaks: Iterable<ExamplePropertySnak>;
}

export interface ExampleStatement {
  id: string;
  property: string;
  value: ExampleSnak;
  rank: StatementRank;
  qualifiers?: Iterable<ExamplePropertySnak>;
  references?: Iterable<ExampleReference>;
}

export interface ExampleEntityDocument {
  entityId: string;
  revision: number;
  statements: Iterable<ExampleStatement>;
}

export interface WikibaseStyleVocabulary {
  baseIri: string;
  entity(id: string): RDF.NamedNode;
  statement(entityId: string, id: string): RDF.NamedNode;
  reference(entityId: string, id: string): RDF.NamedNode;
  entityType: RDF.NamedNode;
  someValueType: RDF.NamedNode;
  noValueType: RDF.NamedNode;
  revision: RDF.NamedNode;
  direct(property: string): RDF.NamedNode;
  claim(property: string): RDF.NamedNode;
  statementValue(property: string): RDF.NamedNode;
  statementFullValue(property: string): RDF.NamedNode;
  qualifier(property: string): RDF.NamedNode;
  qualifierFullValue(property: string): RDF.NamedNode;
  referenceValue(property: string): RDF.NamedNode;
  referenceFullValue(property: string): RDF.NamedNode;
}

export function createWikibaseStyleVocabulary(
  baseIri: string,
): WikibaseStyleVocabulary {
  const base = baseIri.endsWith('/') ? baseIri : `${baseIri}/`;
  const iri = (path: string) => factory.namedNode(`${base}${path}`);
  const id = (value: string) => encodeURIComponent(value);
  return {
    baseIri: base,
    entity: (value) => iri(`entity/${id(value)}`),
    statement: (entityId, value) =>
      iri(`statement/${id(entityId)}/${id(value)}`),
    reference: (entityId, value) =>
      iri(`reference/${id(entityId)}/${id(value)}`),
    entityType: iri('schema/Entity'),
    someValueType: iri('schema/SomeValue'),
    noValueType: iri('schema/NoValue'),
    revision: iri('schema/revision'),
    direct: (property) => iri(`prop/direct/${id(property)}`),
    claim: (property) => iri(`prop/${id(property)}`),
    statementValue: (property) => iri(`prop/statement/${id(property)}`),
    statementFullValue: (property) =>
      iri(`prop/statement/value/${id(property)}`),
    qualifier: (property) => iri(`prop/qualifier/${id(property)}`),
    qualifierFullValue: (property) =>
      iri(`prop/qualifier/value/${id(property)}`),
    referenceValue: (property) => iri(`prop/reference/${id(property)}`),
    referenceFullValue: (property) =>
      iri(`prop/reference/value/${id(property)}`),
  };
}

export function buildWikibaseStyleEntityQuads(
  vocabulary: WikibaseStyleVocabulary,
  document: ExampleEntityDocument,
): RDF.Quad[] {
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) {
    throw new RangeError('revision must be a non-negative safe integer');
  }
  assertIdentifier(document.entityId, 'entityId');
  const entity = vocabulary.entity(document.entityId);
  const statements = [...document.statements];
  const statementIds = new Set<string>();
  for (const statement of statements) {
    assertIdentifier(statement.id, 'statement id');
    assertIdentifier(statement.property, 'statement property');
    if (statementIds.has(statement.id)) {
      throw new TypeError(`duplicate statement id ${statement.id}`);
    }
    statementIds.add(statement.id);
  }
  const bestRankByProperty = new Map<string, StatementRank>();
  for (const statement of statements) {
    if (statement.rank === 'deprecated') {
      continue;
    }
    const current = bestRankByProperty.get(statement.property);
    if (
      current === undefined ||
      rankPriority(statement.rank) > rankPriority(current)
    ) {
      bestRankByProperty.set(statement.property, statement.rank);
    }
  }
  const quads: RDF.Quad[] = [
    entityMarkerQuad(vocabulary, document.entityId),
    revisionQuad(vocabulary, document),
  ];
  const referenceIds = new Set<string>();

  for (const statement of statements) {
    const statementNode = vocabulary.statement(document.entityId, statement.id);
    quads.push(
      factory.quad(entity, vocabulary.claim(statement.property), statementNode),
      factory.quad(
        statementNode,
        RDF_TYPE,
        factory.namedNode(`${WIKIBASE}Statement`),
      ),
      factory.quad(
        statementNode,
        factory.namedNode(`${WIKIBASE}rank`),
        factory.namedNode(
          `${WIKIBASE}${statement.rank[0]!.toUpperCase()}${statement.rank.slice(1)}Rank`,
        ),
      ),
    );
    addSnakQuads(
      quads,
      vocabulary,
      statementNode,
      statement.property,
      statement.value,
      'statement',
      `${document.entityId}-${statement.id}-main`,
    );

    if (statement.rank === bestRankByProperty.get(statement.property)) {
      quads.push(
        factory.quad(
          statementNode,
          RDF_TYPE,
          factory.namedNode(`${WIKIBASE}BestRank`),
        ),
      );
      const directValue = snakTerm(
        vocabulary,
        statement.value,
        `${document.entityId}-${statement.id}-truthy`,
      );
      quads.push(
        factory.quad(
          entity,
          vocabulary.direct(statement.property),
          directValue,
        ),
      );
    }

    for (const [index, qualifier] of [
      ...(statement.qualifiers ?? []),
    ].entries()) {
      addSnakQuads(
        quads,
        vocabulary,
        statementNode,
        qualifier.property,
        qualifier.snak,
        'qualifier',
        `${document.entityId}-${statement.id}-qualifier-${index}`,
      );
    }
    for (const reference of statement.references ?? []) {
      assertIdentifier(reference.id, 'reference id');
      if (referenceIds.has(reference.id)) {
        throw new TypeError(`duplicate reference id ${reference.id}`);
      }
      referenceIds.add(reference.id);
      const referenceNode = vocabulary.reference(
        document.entityId,
        reference.id,
      );
      quads.push(
        factory.quad(statementNode, PROV_DERIVED_FROM, referenceNode),
        factory.quad(
          referenceNode,
          RDF_TYPE,
          factory.namedNode(`${WIKIBASE}Reference`),
        ),
      );
      for (const [index, referenceSnak] of [...reference.snaks].entries()) {
        addSnakQuads(
          quads,
          vocabulary,
          referenceNode,
          referenceSnak.property,
          referenceSnak.snak,
          'reference',
          `${document.entityId}-${reference.id}-snak-${index}`,
        );
      }
    }
  }
  return quads;
}

export async function replaceWikibaseStyleEntity(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  after: ExampleEntityDocument,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  if (before.entityId !== after.entityId) {
    throw new TypeError('an entity replacement cannot change its entityId');
  }
  if (before.revision !== expectedRevision) {
    throw new TypeError('before.revision must equal expectedRevision');
  }
  if (after.revision <= before.revision) {
    throw new TypeError('the replacement revision must increase');
  }
  return applyQuadPatch(db, {
    require: [revisionQuad(vocabulary, before)],
    delete: buildWikibaseStyleEntityQuads(vocabulary, before),
    insert: buildWikibaseStyleEntityQuads(vocabulary, after),
  });
}

export async function createWikibaseStyleEntity(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  document: ExampleEntityDocument,
): Promise<QuadPatchResult> {
  return applyQuadPatch(db, {
    forbid: [entityMarkerQuad(vocabulary, document.entityId)],
    insert: buildWikibaseStyleEntityQuads(vocabulary, document),
  });
}

export async function deleteWikibaseStyleEntity(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  if (before.revision !== expectedRevision) {
    throw new TypeError('before.revision must equal expectedRevision');
  }
  return applyQuadPatch(db, {
    require: [revisionQuad(vocabulary, before)],
    delete: buildWikibaseStyleEntityQuads(vocabulary, before),
  });
}

export async function replaceWikibaseStyleStatement(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  statementId: string,
  replacement: ExampleStatement,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  if (statementId !== replacement.id) {
    throw new TypeError('replacement.id must retain the stable statement id');
  }
  const beforeStatements = [...before.statements];
  const afterStatements = [...beforeStatements];
  const position = afterStatements.findIndex(({ id }) => id === statementId);
  if (position < 0) {
    throw new RangeError(`statement ${statementId} does not exist`);
  }
  afterStatements[position] = replacement;
  return replaceWikibaseStyleEntity(
    db,
    vocabulary,
    { ...before, statements: beforeStatements },
    { ...before, revision: before.revision + 1, statements: afterStatements },
    expectedRevision,
  );
}

export async function setWikibaseStyleStatementRank(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  statementId: string,
  rank: StatementRank,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  const beforeStatements = [...before.statements];
  const current = beforeStatements.find(({ id }) => id === statementId);
  if (!current) {
    throw new RangeError(`statement ${statementId} does not exist`);
  }
  return replaceWikibaseStyleStatement(
    db,
    vocabulary,
    { ...before, statements: beforeStatements },
    statementId,
    { ...current, rank },
    expectedRevision,
  );
}

export async function addWikibaseStyleStatement(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  statement: ExampleStatement,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  const beforeStatements = [...before.statements];
  if (beforeStatements.some(({ id }) => id === statement.id)) {
    throw new TypeError(`statement ${statement.id} already exists`);
  }
  return replaceWikibaseStyleEntity(
    db,
    vocabulary,
    { ...before, statements: beforeStatements },
    {
      ...before,
      revision: before.revision + 1,
      statements: [...beforeStatements, statement],
    },
    expectedRevision,
  );
}

export async function deleteWikibaseStyleStatement(
  db: D1DatabaseLike,
  vocabulary: WikibaseStyleVocabulary,
  before: ExampleEntityDocument,
  statementId: string,
  expectedRevision: number,
): Promise<QuadPatchResult> {
  const beforeStatements = [...before.statements];
  const afterStatements = beforeStatements.filter(
    ({ id }) => id !== statementId,
  );
  if (afterStatements.length === beforeStatements.length) {
    throw new RangeError(`statement ${statementId} does not exist`);
  }
  return replaceWikibaseStyleEntity(
    db,
    vocabulary,
    { ...before, statements: beforeStatements },
    { ...before, revision: before.revision + 1, statements: afterStatements },
    expectedRevision,
  );
}

function entityMarkerQuad(
  vocabulary: WikibaseStyleVocabulary,
  entityId: string,
): RDF.Quad {
  return factory.quad(
    vocabulary.entity(entityId),
    RDF_TYPE,
    vocabulary.entityType,
  );
}

function revisionQuad(
  vocabulary: WikibaseStyleVocabulary,
  document: ExampleEntityDocument,
): RDF.Quad {
  return factory.quad(
    vocabulary.entity(document.entityId),
    vocabulary.revision,
    factory.literal(String(document.revision), XSD_INTEGER),
  );
}

function addSnakQuads(
  quads: RDF.Quad[],
  vocabulary: WikibaseStyleVocabulary,
  owner: RDF.Term,
  property: string,
  snak: ExampleSnak,
  family: 'statement' | 'qualifier' | 'reference',
  markerId: string,
): void {
  const simplePredicate =
    family === 'statement'
      ? vocabulary.statementValue(property)
      : family === 'qualifier'
        ? vocabulary.qualifier(property)
        : vocabulary.referenceValue(property);
  const fullPredicate =
    family === 'statement'
      ? vocabulary.statementFullValue(property)
      : family === 'qualifier'
        ? vocabulary.qualifierFullValue(property)
        : vocabulary.referenceFullValue(property);
  quads.push(
    factory.quad(
      owner as RDF.Quad_Subject,
      simplePredicate,
      snakTerm(vocabulary, snak, markerId) as RDF.Quad_Object,
    ),
  );
  if (snak.kind !== 'value') {
    quads.push(
      factory.quad(
        snakTerm(vocabulary, snak, markerId) as RDF.Quad_Subject,
        RDF_TYPE,
        snak.kind === 'somevalue'
          ? vocabulary.someValueType
          : vocabulary.noValueType,
      ),
    );
  }
  if (snak.kind === 'value' && snak.fullValue) {
    quads.push(
      factory.quad(
        owner as RDF.Quad_Subject,
        fullPredicate,
        snak.fullValue.node as RDF.Quad_Object,
      ),
      ...snak.fullValue.quads,
    );
  }
}

function snakTerm(
  vocabulary: WikibaseStyleVocabulary,
  snak: ExampleSnak,
  markerId: string,
): RDF.Term {
  if (snak.kind === 'value') {
    return snak.value;
  }
  const marker = factory.namedNode(
    `${vocabulary.baseIri}special/${snak.kind}/${encodeURIComponent(markerId)}`,
  );
  return marker;
}

function rankPriority(rank: StatementRank): number {
  return rank === 'preferred' ? 2 : rank === 'normal' ? 1 : 0;
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
}
