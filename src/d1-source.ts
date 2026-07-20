import type * as RDF from '@rdfjs/types';
import { BufferedIterator, wrap } from 'asynciterator';
import { EventEmitter } from 'node:events';
import { DataFactory } from 'rdf-data-factory';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from './d1-types.js';
import { decodeTerm, encodeTerm } from './term-codec.js';

const SELECT_COLUMNS = [
  'subject_json',
  'predicate_json',
  'object_json',
  'graph_json',
].join(', ');

const POSITION_COLUMNS = [
  'subject_key',
  'predicate_key',
  'object_key',
  'graph_key',
] as const;

/** Leaves headroom below D1's 2 MB maximum bound string size. */
export const MAX_ATOMIC_WRITE_BYTES = 1_900_000;

interface QuadRow {
  subject_json: string;
  predicate_json: string;
  object_json: string;
  graph_json: string;
}

interface PageQuadRow extends QuadRow {
  subject_key: string;
  predicate_key: string;
  object_key: string;
  graph_key: string;
}

type QuadCursor = readonly [string, string, string, string];

interface CountRow {
  count: number;
}

export interface QueryObservation {
  operation: 'match' | 'count';
  boundPositions: number;
  durationMs: number;
  returnedRows: number;
  metadata?: Record<string, unknown>;
}

export interface D1QuadSourceOptions {
  observe?: (observation: QueryObservation) => void;
  /** Enables deterministic keyset pagination when set to a positive integer. */
  pageSize?: number;
}

export interface QuadPatch {
  /** Every required quad must exist at transaction start or nothing changes. */
  require?: Iterable<RDF.Quad>;
  /** Every forbidden quad must be absent at transaction start or nothing changes. */
  forbid?: Iterable<RDF.Quad>;
  delete?: Iterable<RDF.Quad>;
  insert?: Iterable<RDF.Quad>;
}

export interface QuadPatchResult {
  deleted: number;
  inserted: number;
}

/**
 * A validated quad patch that can be included in a caller-owned D1 batch.
 * Execute every statement, in order, as one batch. Pass the complete batch
 * result and the plan's starting offset to `readResult` after it succeeds.
 */
export interface PreparedQuadPatch {
  readonly statements: readonly D1PreparedStatementLike[];
  /** Maps the patch's deliberate guard assertion failure to its typed error. */
  mapError(cause: unknown): Error;
  readResult(
    results: readonly D1ResultLike[],
    offset?: number,
  ): QuadPatchResult;
}

export class QuadPatchConflictError extends Error {
  constructor() {
    super('Quad patch precondition failed');
    this.name = 'QuadPatchConflictError';
  }
}

function concreteTerm(term?: RDF.Term | null): RDF.Term | null {
  return term && term.termType !== 'Variable' ? term : null;
}

function buildWhere(terms: ReadonlyArray<RDF.Term | null>): {
  clause: string;
  values: string[];
} {
  const predicates: string[] = [];
  const values: string[] = [];

  terms.forEach((term, index) => {
    if (term) {
      predicates.push(`${POSITION_COLUMNS[index]} = ?`);
      values.push(encodeTerm(term).key);
    }
  });

  return {
    clause: predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '',
    values,
  };
}

export class D1QuadSource implements RDF.Source {
  readonly #db: D1DatabaseLike;
  readonly #observe: ((observation: QueryObservation) => void) | undefined;
  readonly #pageSize: number | undefined;

  constructor(db: D1DatabaseLike, options: D1QuadSourceOptions = {}) {
    this.#db = db;
    this.#observe = options.observe;
    if (
      options.pageSize !== undefined &&
      (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0)
    ) {
      throw new RangeError('pageSize must be a positive safe integer');
    }
    this.#pageSize = options.pageSize;
  }

  match(
    subject?: RDF.Term | null,
    predicate?: RDF.Term | null,
    object?: RDF.Term | null,
    graph?: RDF.Term | null,
  ): RDF.Stream<RDF.Quad> {
    const terms = [subject, predicate, object, graph].map(concreteTerm);
    if (this.#pageSize !== undefined) {
      return new D1QuadPageIterator(
        this.#db,
        terms,
        this.#pageSize,
        this.#observe,
      );
    }
    return wrap(this.#match(terms));
  }

  async countQuads(
    subject?: RDF.Term | null,
    predicate?: RDF.Term | null,
    object?: RDF.Term | null,
    graph?: RDF.Term | null,
  ): Promise<number> {
    const terms = [subject, predicate, object, graph].map(concreteTerm);
    const { clause, values } = buildWhere(terms);
    const started = performance.now();
    const result = await this.#db
      .prepare(`SELECT COUNT(*) AS count FROM rdf_quads${clause}`)
      .bind(...values)
      .all<CountRow>();
    const count = result.results[0]?.count ?? 0;
    this.#emitObservation('count', terms, started, count, result);
    return count;
  }

  async #match(terms: ReadonlyArray<RDF.Term | null>): Promise<RDF.Quad[]> {
    const { clause, values } = buildWhere(terms);
    const started = performance.now();
    const result = await this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM rdf_quads${clause}`)
      .bind(...values)
      .all<QuadRow>();
    const quads = result.results.map(rowToQuad);
    this.#emitObservation('match', terms, started, quads.length, result);
    return quads;
  }

  #emitObservation<T>(
    operation: QueryObservation['operation'],
    terms: ReadonlyArray<RDF.Term | null>,
    started: number,
    returnedRows: number,
    result: D1ResultLike<T>,
  ): void {
    this.#observe?.({
      operation,
      boundPositions: terms.filter(Boolean).length,
      durationMs: performance.now() - started,
      returnedRows,
      ...(result.meta ? { metadata: result.meta } : {}),
    });
  }
}

class D1QuadPageIterator extends BufferedIterator<RDF.Quad> {
  readonly #db: D1DatabaseLike;
  readonly #terms: ReadonlyArray<RDF.Term | null>;
  readonly #pageSize: number;
  readonly #observe: ((observation: QueryObservation) => void) | undefined;
  #cursor: QuadCursor | undefined;
  #page = 0;

  constructor(
    db: D1DatabaseLike,
    terms: ReadonlyArray<RDF.Term | null>,
    pageSize: number,
    observe: ((observation: QueryObservation) => void) | undefined,
  ) {
    super({ maxBufferSize: pageSize, autoStart: false });
    this.#db = db;
    this.#terms = terms;
    this.#pageSize = pageSize;
    this.#observe = observe;
  }

  protected override _read(_count: number, done: () => void): void {
    void this.#readPage().then(done, (cause: unknown) => {
      this.destroy(cause instanceof Error ? cause : new Error(String(cause)));
      done();
    });
  }

  async #readPage(): Promise<void> {
    if (this.done) {
      return;
    }
    const { clause: boundClause, values: boundValues } = buildWhere(
      this.#terms,
    );
    const cursorClause = this.#cursor
      ? `${boundClause ? ' AND' : ' WHERE'}
        (subject_key, predicate_key, object_key, graph_key) > (?, ?, ?, ?)`
      : '';
    const cursorValues = this.#cursor ? [...this.#cursor] : [];
    const started = performance.now();
    const result = await this.#db
      .prepare(
        `SELECT ${POSITION_COLUMNS.join(', ')}, ${SELECT_COLUMNS}
        FROM rdf_quads${boundClause}${cursorClause}
        ORDER BY ${POSITION_COLUMNS.join(', ')}
        LIMIT ?`,
      )
      .bind(...boundValues, ...cursorValues, this.#pageSize + 1)
      .all<PageQuadRow>();
    if (this.done) {
      return;
    }

    this.#page += 1;
    const rows = result.results.slice(0, this.#pageSize);
    for (const row of rows) {
      this._push(rowToQuad(row));
    }
    const last = rows.at(-1);
    if (last) {
      this.#cursor = [
        last.subject_key,
        last.predicate_key,
        last.object_key,
        last.graph_key,
      ];
    }
    this.#observe?.({
      operation: 'match',
      boundPositions: this.#terms.filter(Boolean).length,
      durationMs: performance.now() - started,
      returnedRows: rows.length,
      metadata: {
        ...result.meta,
        readMode: 'paginated',
        page: this.#page,
        pageSize: this.#pageSize,
      },
    });
    if (result.results.length <= this.#pageSize) {
      this.close();
    }
  }
}

function rowToQuad(row: QuadRow): RDF.Quad {
  return new DataViewQuad(
    decodeTerm(row.subject_json),
    decodeTerm(row.predicate_json),
    decodeTerm(row.object_json),
    decodeTerm(row.graph_json),
  ).toQuad();
}

class DataViewQuad {
  constructor(
    readonly subject: RDF.Term,
    readonly predicate: RDF.Term,
    readonly object: RDF.Term,
    readonly graph: RDF.Term,
  ) {}

  toQuad(): RDF.Quad {
    const encoded = JSON.stringify({
      t: 'Quad',
      s: JSON.parse(encodeTerm(this.subject).json),
      p: JSON.parse(encodeTerm(this.predicate).json),
      o: JSON.parse(encodeTerm(this.object).json),
      g: JSON.parse(encodeTerm(this.graph).json),
    });
    return decodeTerm(encoded) as RDF.Quad;
  }
}

export async function insertQuads(
  db: D1DatabaseLike,
  quads: Iterable<RDF.Quad>,
): Promise<number> {
  const rows = encodeInsertRows(quads);

  if (!rows.length) {
    return 0;
  }
  const payload = atomicPayload(rows);
  const result = await prepareInsert(db, payload).run();
  return Number(result.meta?.changes ?? 0);
}

export async function deleteMatchingQuads(
  db: D1DatabaseLike,
  subject?: RDF.Term | null,
  predicate?: RDF.Term | null,
  object?: RDF.Term | null,
  graph?: RDF.Term | null,
): Promise<number> {
  const terms = [subject, predicate, object, graph].map(concreteTerm);
  assertValidPattern(terms);
  const { clause, values } = buildWhere(terms);
  const result = await db
    .prepare(`DELETE FROM rdf_quads${clause}`)
    .bind(...values)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function deleteQuads(
  db: D1DatabaseLike,
  quads: Iterable<RDF.Quad>,
): Promise<number> {
  const rows = encodeDeleteRows(quads);
  if (!rows.length) {
    return 0;
  }
  const result = await prepareDelete(db, atomicPayload(rows)).run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * Atomically applies exact quad deletions followed by idempotent insertions.
 * All terms and the aggregate payload are validated before D1 is touched.
 */
export async function applyQuadPatch(
  db: D1DatabaseLike,
  patch: QuadPatch,
): Promise<QuadPatchResult> {
  const prepared = prepareQuadPatch(db, patch);
  if (!prepared.statements.length) {
    return prepared.readResult([]);
  }
  try {
    const results = await db.batch([...prepared.statements]);
    return prepared.readResult(results);
  } catch (cause) {
    throw prepared.mapError(cause);
  }
}

/**
 * Validates and prepares a quad patch without executing it. The returned
 * statements are transaction-composable with adjacent application writes.
 * Callers must execute the complete sequence in order in one D1 batch.
 */
export function prepareQuadPatch(
  db: D1DatabaseLike,
  patch: QuadPatch,
): PreparedQuadPatch {
  const requireRows = encodeDeleteRows(patch.require ?? []);
  const forbidRows = encodeDeleteRows(patch.forbid ?? []);
  const deleteRows = encodeDeleteRows(patch.delete ?? []);
  const insertRows = encodeInsertRows(patch.insert ?? []);
  if (
    !requireRows.length &&
    !forbidRows.length &&
    !deleteRows.length &&
    !insertRows.length
  ) {
    return preparedPatch([], undefined, undefined, undefined);
  }

  const requirePayload = requireRows.length
    ? JSON.stringify(requireRows)
    : null;
  const forbidPayload = forbidRows.length ? JSON.stringify(forbidRows) : null;
  const deletePayload = deleteRows.length ? JSON.stringify(deleteRows) : null;
  const insertPayload = insertRows.length ? JSON.stringify(insertRows) : null;
  assertAtomicPayloadSize(
    [requirePayload, forbidPayload, deletePayload, insertPayload].filter(
      (payload): payload is string => payload !== null,
    ),
  );

  const statements: D1PreparedStatementLike[] = [];
  let guardResultIndex: number | undefined;
  let deleteResultIndex: number | undefined;
  let insertResultIndex: number | undefined;
  const guardId =
    requirePayload !== null || forbidPayload !== null
      ? crypto.randomUUID()
      : undefined;
  if (guardId !== undefined) {
    guardResultIndex = statements.length;
    statements.push(prepareGuard(db, guardId, requirePayload, forbidPayload));
    statements.push(prepareGuardAssertion(db, guardId));
  }
  if (deletePayload !== null) {
    deleteResultIndex = statements.length;
    statements.push(prepareDelete(db, deletePayload, guardId));
  }
  if (insertPayload !== null) {
    insertResultIndex = statements.length;
    statements.push(prepareInsert(db, insertPayload, guardId));
  }
  if (guardId !== undefined) {
    statements.push(
      db
        .prepare('DELETE FROM rdf_patch_guards WHERE patch_id = ?')
        .bind(guardId),
    );
  }

  return preparedPatch(
    statements,
    guardResultIndex,
    deleteResultIndex,
    insertResultIndex,
  );
}

function preparedPatch(
  statements: D1PreparedStatementLike[],
  guardResultIndex: number | undefined,
  deleteResultIndex: number | undefined,
  insertResultIndex: number | undefined,
): PreparedQuadPatch {
  return {
    statements,
    mapError(cause) {
      if (
        guardResultIndex !== undefined &&
        cause instanceof Error &&
        /NOT NULL constraint failed: rdf_patch_guards\.patch_id/iu.test(
          cause.message,
        )
      ) {
        return new QuadPatchConflictError();
      }
      return cause instanceof Error ? cause : new Error(String(cause));
    },
    readResult(results, offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError(
          'Quad patch result offset must be a non-negative safe integer',
        );
      }
      if (results.length < offset + statements.length) {
        throw new RangeError('Quad patch batch results are incomplete');
      }
      if (
        guardResultIndex !== undefined &&
        Number(results[offset + guardResultIndex]?.meta?.changes ?? 0) !== 1
      ) {
        throw new QuadPatchConflictError();
      }
      return {
        deleted:
          deleteResultIndex === undefined
            ? 0
            : Number(results[offset + deleteResultIndex]?.meta?.changes ?? 0),
        inserted:
          insertResultIndex === undefined
            ? 0
            : Number(results[offset + insertResultIndex]?.meta?.changes ?? 0),
      };
    },
  };
}

function encodeInsertRows(quads: Iterable<RDF.Quad>) {
  return [...quads].map((quad) => {
    assertValidQuad(quad);
    const subject = encodeTerm(quad.subject);
    const predicate = encodeTerm(quad.predicate);
    const object = encodeTerm(quad.object);
    const graph = encodeTerm(quad.graph);
    return {
      subjectKey: subject.key,
      subjectJson: subject.json,
      predicateKey: predicate.key,
      predicateJson: predicate.json,
      objectKey: object.key,
      objectJson: object.json,
      graphKey: graph.key,
      graphJson: graph.json,
    };
  });
}

function encodeDeleteRows(quads: Iterable<RDF.Quad>) {
  return [...quads].map((quad) => {
    assertValidQuad(quad);
    return {
      subjectKey: encodeTerm(quad.subject).key,
      predicateKey: encodeTerm(quad.predicate).key,
      objectKey: encodeTerm(quad.object).key,
      graphKey: encodeTerm(quad.graph).key,
    };
  });
}

function assertValidQuad(quad: RDF.Quad): void {
  if (!quad || quad.termType !== 'Quad') {
    throw new TypeError('RDF writes require RDF/JS Quad values');
  }
  assertValidTriple(quad, new Set<RDF.BaseQuad>());
  assertGraphTerm(quad.graph, 'quad graph');
}

function assertValidTriple(
  quad: RDF.BaseQuad,
  ancestors: Set<RDF.BaseQuad>,
): void {
  if (ancestors.has(quad)) {
    throw new TypeError('Quoted triples cannot contain a cyclic term');
  }
  ancestors.add(quad);
  assertSubjectTerm(quad.subject, ancestors);
  if (quad.predicate?.termType !== 'NamedNode') {
    throw new TypeError('RDF predicates must be NamedNode terms');
  }
  assertObjectTerm(quad.object, ancestors);
  ancestors.delete(quad);
}

function assertSubjectTerm(term: RDF.Term, ancestors: Set<RDF.BaseQuad>): void {
  if (term?.termType === 'NamedNode' || term?.termType === 'BlankNode') {
    return;
  }
  if (term?.termType === 'Quad') {
    assertQuotedTriple(term, ancestors);
    return;
  }
  throw new TypeError(
    'RDF subjects must be NamedNode, BlankNode, or quoted-triple terms',
  );
}

function assertObjectTerm(term: RDF.Term, ancestors: Set<RDF.BaseQuad>): void {
  if (
    term?.termType === 'NamedNode' ||
    term?.termType === 'BlankNode' ||
    term?.termType === 'Literal'
  ) {
    return;
  }
  if (term?.termType === 'Quad') {
    assertQuotedTriple(term, ancestors);
    return;
  }
  throw new TypeError(
    'RDF objects must be NamedNode, BlankNode, Literal, or quoted-triple terms',
  );
}

function assertQuotedTriple(
  quad: RDF.BaseQuad,
  ancestors: Set<RDF.BaseQuad>,
): void {
  if (quad.graph?.termType !== 'DefaultGraph') {
    throw new TypeError('Quoted triples must use the default graph component');
  }
  assertValidTriple(quad, ancestors);
}

function assertGraphTerm(term: RDF.Term, context: string): void {
  if (
    term?.termType !== 'DefaultGraph' &&
    term?.termType !== 'NamedNode' &&
    term?.termType !== 'BlankNode'
  ) {
    throw new TypeError(
      `${context} must be a DefaultGraph, NamedNode, or BlankNode term`,
    );
  }
}

function assertValidPattern(terms: ReadonlyArray<RDF.Term | null>): void {
  const [subject, predicate, object, graph] = terms;
  if (subject) {
    assertSubjectTerm(subject, new Set<RDF.BaseQuad>());
  }
  if (predicate && predicate.termType !== 'NamedNode') {
    throw new TypeError('RDF predicates must be NamedNode terms');
  }
  if (object) {
    assertObjectTerm(object, new Set<RDF.BaseQuad>());
  }
  if (graph) {
    assertGraphTerm(graph, 'quad graph');
  }
}

function prepareGuard(
  db: D1DatabaseLike,
  guardId: string,
  requirePayload: string | null,
  forbidPayload: string | null,
) {
  return db
    .prepare(
      `INSERT INTO rdf_patch_guards (patch_id)
      SELECT ?
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(?) AS required
        WHERE NOT EXISTS (
          SELECT 1 FROM rdf_quads AS existing
          WHERE existing.subject_key = json_extract(required.value, '$.subjectKey')
            AND existing.predicate_key = json_extract(required.value, '$.predicateKey')
            AND existing.object_key = json_extract(required.value, '$.objectKey')
            AND existing.graph_key = json_extract(required.value, '$.graphKey')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS forbidden
        WHERE EXISTS (
          SELECT 1 FROM rdf_quads AS existing
          WHERE existing.subject_key = json_extract(forbidden.value, '$.subjectKey')
            AND existing.predicate_key = json_extract(forbidden.value, '$.predicateKey')
            AND existing.object_key = json_extract(forbidden.value, '$.objectKey')
            AND existing.graph_key = json_extract(forbidden.value, '$.graphKey')
        )
      )`,
    )
    .bind(guardId, requirePayload, forbidPayload);
}

function prepareGuardAssertion(db: D1DatabaseLike, guardId: string) {
  return db
    .prepare(
      `INSERT INTO rdf_patch_guards (patch_id)
      SELECT NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM rdf_patch_guards WHERE patch_id = ?
      )`,
    )
    .bind(guardId);
}

function prepareDelete(db: D1DatabaseLike, payload: string, guardId?: string) {
  const guardClause = guardId
    ? ' AND EXISTS (SELECT 1 FROM rdf_patch_guards WHERE patch_id = ?)'
    : '';
  return db
    .prepare(
      `DELETE FROM rdf_quads
      WHERE EXISTS (
        SELECT 1 FROM json_each(?) AS input
        WHERE subject_key = json_extract(input.value, '$.subjectKey')
          AND predicate_key = json_extract(input.value, '$.predicateKey')
          AND object_key = json_extract(input.value, '$.objectKey')
          AND graph_key = json_extract(input.value, '$.graphKey')
      )${guardClause}`,
    )
    .bind(payload, ...(guardId ? [guardId] : []));
}

function prepareInsert(db: D1DatabaseLike, payload: string, guardId?: string) {
  const guardClause = guardId
    ? 'EXISTS (SELECT 1 FROM rdf_patch_guards WHERE patch_id = ?) AND '
    : '';
  return db
    .prepare(
      `INSERT INTO rdf_quads (
        subject_key, subject_json,
        predicate_key, predicate_json,
        object_key, object_json,
        graph_key, graph_json
      )
      SELECT
        json_extract(value, '$.subjectKey'),
        json_extract(value, '$.subjectJson'),
        json_extract(value, '$.predicateKey'),
        json_extract(value, '$.predicateJson'),
        json_extract(value, '$.objectKey'),
        json_extract(value, '$.objectJson'),
        json_extract(value, '$.graphKey'),
        json_extract(value, '$.graphJson')
      FROM json_each(?)
      WHERE ${guardClause}true
      ON CONFLICT(subject_key, predicate_key, object_key, graph_key) DO NOTHING`,
    )
    .bind(payload, ...(guardId ? [guardId] : []));
}

function atomicPayload(value: unknown): string {
  const payload = JSON.stringify(value);
  assertAtomicPayloadSize([payload]);
  return payload;
}

function assertAtomicPayloadSize(payloads: string[]): void {
  const bytes = payloads.reduce(
    (total, payload) => total + new TextEncoder().encode(payload).byteLength,
    0,
  );
  if (bytes > MAX_ATOMIC_WRITE_BYTES) {
    throw new RangeError(
      `Atomic RDF write exceeds ${MAX_ATOMIC_WRITE_BYTES} bytes; split it at the application boundary`,
    );
  }
}

export class D1QuadStore extends D1QuadSource implements RDF.Store {
  readonly #storeDb: D1DatabaseLike;
  readonly #factory = new DataFactory();

  constructor(db: D1DatabaseLike, options: D1QuadSourceOptions = {}) {
    super(db, options);
    this.#storeDb = db;
  }

  import(stream: RDF.Stream<RDF.Quad>): EventEmitter {
    return consumeQuadStream(stream, (quads) =>
      insertQuads(this.#storeDb, quads),
    );
  }

  remove(stream: RDF.Stream<RDF.Quad>): EventEmitter {
    return consumeQuadStream(stream, (quads) =>
      deleteQuads(this.#storeDb, quads),
    );
  }

  removeMatches(
    subject?: RDF.Term | null,
    predicate?: RDF.Term | null,
    object?: RDF.Term | null,
    graph?: RDF.Term | null,
  ): EventEmitter {
    return emitOperation(() =>
      deleteMatchingQuads(this.#storeDb, subject, predicate, object, graph),
    );
  }

  deleteGraph(graph: RDF.Quad_Graph | string): EventEmitter {
    const graphTerm =
      typeof graph === 'string' ? this.#factory.namedNode(graph) : graph;
    return this.removeMatches(null, null, null, graphTerm);
  }
}

function consumeQuadStream(
  stream: RDF.Stream<RDF.Quad>,
  operation: (quads: RDF.Quad[]) => Promise<unknown>,
): EventEmitter {
  const output = new EventEmitter();
  const quads: RDF.Quad[] = [];
  let settled = false;
  const cleanup = () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
  };
  const onData = (quad: RDF.Quad) => {
    if (!settled) {
      quads.push(quad);
    }
  };
  const onError = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    output.emit('error', error);
  };
  const onEnd = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    void operation(quads).then(
      () => output.emit('end'),
      (error) => output.emit('error', error),
    );
  };
  stream.on('data', onData);
  stream.on('error', onError);
  stream.on('end', onEnd);
  return output;
}

function emitOperation(operation: () => Promise<unknown>): EventEmitter {
  const output = new EventEmitter();
  queueMicrotask(() => {
    void operation().then(
      () => output.emit('end'),
      (error) => output.emit('error', error),
    );
  });
  return output;
}
