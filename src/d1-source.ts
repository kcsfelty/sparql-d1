import type * as RDF from '@rdfjs/types';
import { wrap } from 'asynciterator';
import { EventEmitter } from 'node:events';
import { DataFactory } from 'rdf-data-factory';
import type { D1DatabaseLike, D1ResultLike } from './d1-types.js';
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

  constructor(db: D1DatabaseLike, options: D1QuadSourceOptions = {}) {
    this.#db = db;
    this.#observe = options.observe;
  }

  match(
    subject?: RDF.Term | null,
    predicate?: RDF.Term | null,
    object?: RDF.Term | null,
    graph?: RDF.Term | null,
  ): RDF.Stream<RDF.Quad> {
    const terms = [subject, predicate, object, graph].map(concreteTerm);
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
    const quads = result.results.map((row) =>
      new DataViewQuad(
        decodeTerm(row.subject_json),
        decodeTerm(row.predicate_json),
        decodeTerm(row.object_json),
        decodeTerm(row.graph_json),
      ).toQuad(),
    );
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
  const rows = [...quads].map((quad) => {
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

  if (!rows.length) {
    return 0;
  }
  const payload = atomicPayload(rows);
  const result = await db
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
      WHERE true
      ON CONFLICT(subject_key, predicate_key, object_key, graph_key) DO NOTHING`,
    )
    .bind(payload)
    .run();
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
  const rows = [...quads].map((quad) => {
    return {
      subjectKey: encodeTerm(quad.subject).key,
      predicateKey: encodeTerm(quad.predicate).key,
      objectKey: encodeTerm(quad.object).key,
      graphKey: encodeTerm(quad.graph).key,
    };
  });
  if (!rows.length) {
    return 0;
  }
  const result = await db
    .prepare(
      `DELETE FROM rdf_quads
      WHERE EXISTS (
        SELECT 1 FROM json_each(?) AS input
        WHERE subject_key = json_extract(input.value, '$.subjectKey')
          AND predicate_key = json_extract(input.value, '$.predicateKey')
          AND object_key = json_extract(input.value, '$.objectKey')
          AND graph_key = json_extract(input.value, '$.graphKey')
      )`,
    )
    .bind(atomicPayload(rows))
    .run();
  return Number(result.meta?.changes ?? 0);
}

function atomicPayload(value: unknown): string {
  const payload = JSON.stringify(value);
  if (new TextEncoder().encode(payload).byteLength > MAX_ATOMIC_WRITE_BYTES) {
    throw new RangeError(
      `Atomic RDF write exceeds ${MAX_ATOMIC_WRITE_BYTES} bytes; split it at the application boundary`,
    );
  }
  return payload;
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
  stream.on('data', (quad) => quads.push(quad));
  stream.on('error', (error) => output.emit('error', error));
  stream.on('end', () => {
    void operation(quads).then(
      () => output.emit('end'),
      (error) => output.emit('error', error),
    );
  });
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
