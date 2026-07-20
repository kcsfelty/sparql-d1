import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { DataFactory } from 'rdf-data-factory';
import { encodeTerm } from '../src/term-codec.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://storage-benchmark.test/${value}`);
const predicates = [ex('type'), ex('name'), ex('group'), ex('knows')];
const people = 2_000;
const rows = Array.from({ length: people }, (_, index) => {
  const subject = ex(`person-${index}`);
  return [
    factory.quad(subject, predicates[0]!, ex('Person')),
    factory.quad(subject, predicates[1]!, factory.literal(`Person ${index}`)),
    factory.quad(subject, predicates[2]!, ex(`group-${index % 20}`)),
    factory.quad(subject, predicates[3]!, ex(`person-${(index + 1) % people}`)),
  ];
})
  .flat()
  .map((quad) => {
    const terms = [
      encodeTerm(quad.subject),
      encodeTerm(quad.predicate),
      encodeTerm(quad.object),
      encodeTerm(quad.graph),
    ];
    return terms.flatMap(({ key, json }) => [key, json]);
  });

interface VariantResult {
  name: string;
  bytes: number;
  insertMs: number;
  subjectRows: number;
  predicateRows: number;
  subjectQueryP50Ms: number;
  subjectPlan: string[];
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function measureQuery(statement: Database.Statement, value: string) {
  const durations: number[] = [];
  let resultRows = 0;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const started = performance.now();
    resultRows = statement.all(value).length;
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return {
    resultRows,
    p50Ms: Number(percentile(durations, 0.5).toFixed(4)),
  };
}

function pageBytes(db: Database.Database): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

function jsonVariant(name: string, redundantSpog: boolean): VariantResult {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rdf_quads (
      id INTEGER PRIMARY KEY,
      subject_key TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      predicate_key TEXT NOT NULL,
      predicate_json TEXT NOT NULL,
      object_key TEXT NOT NULL,
      object_json TEXT NOT NULL,
      graph_key TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      UNIQUE (subject_key, predicate_key, object_key, graph_key)
    ) STRICT;
    CREATE INDEX rdf_quads_pogs_idx ON rdf_quads
      (predicate_key, object_key, graph_key, subject_key);
    CREATE INDEX rdf_quads_ogsp_idx ON rdf_quads
      (object_key, graph_key, subject_key, predicate_key);
    CREATE INDEX rdf_quads_gspo_idx ON rdf_quads
      (graph_key, subject_key, predicate_key, object_key);`);
    if (redundantSpog) {
      db.exec(`CREATE INDEX rdf_quads_spog_idx ON rdf_quads
        (subject_key, predicate_key, object_key, graph_key)`);
    }
    const insert = db.prepare(
      `INSERT INTO rdf_quads (
        subject_key, subject_json, predicate_key, predicate_json,
        object_key, object_json, graph_key, graph_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const started = performance.now();
    db.transaction(() => rows.forEach((row) => insert.run(...row)))();
    const insertMs = performance.now() - started;
    const subjectKey = rows[4_000]![0] as string;
    const predicateKey = encodeTerm(predicates[0]!).key;
    const subjectStatement = db.prepare(
      'SELECT * FROM rdf_quads WHERE subject_key = ?',
    );
    const subject = measureQuery(subjectStatement, subjectKey);
    const predicateRows = db
      .prepare('SELECT subject_key FROM rdf_quads WHERE predicate_key = ?')
      .all(predicateKey).length;
    const subjectPlan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM rdf_quads WHERE subject_key = ?',
      )
      .all(subjectKey)
      .map((row) => String((row as { detail: unknown }).detail));
    return {
      name,
      bytes: pageBytes(db),
      insertMs: Number(insertMs.toFixed(3)),
      subjectRows: subject.resultRows,
      predicateRows,
      subjectQueryP50Ms: subject.p50Ms,
      subjectPlan,
    };
  } finally {
    db.close();
  }
}

function dictionaryVariant(): VariantResult {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rdf_terms (
      term_key TEXT PRIMARY KEY,
      term_json TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE rdf_quads (
      subject_key TEXT NOT NULL,
      predicate_key TEXT NOT NULL,
      object_key TEXT NOT NULL,
      graph_key TEXT NOT NULL,
      PRIMARY KEY (subject_key, predicate_key, object_key, graph_key)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX rdf_quads_posg_idx ON rdf_quads
      (predicate_key, object_key, subject_key, graph_key);
    CREATE INDEX rdf_quads_ospg_idx ON rdf_quads
      (object_key, subject_key, predicate_key, graph_key);
    CREATE INDEX rdf_quads_gspo_idx ON rdf_quads
      (graph_key, subject_key, predicate_key, object_key);`);
    const insertTerm = db.prepare(
      'INSERT OR IGNORE INTO rdf_terms VALUES (?, ?)',
    );
    const insertQuad = db.prepare('INSERT INTO rdf_quads VALUES (?, ?, ?, ?)');
    const started = performance.now();
    db.transaction(() => {
      for (const row of rows) {
        for (let position = 0; position < 4; position += 1) {
          insertTerm.run(row[position * 2], row[position * 2 + 1]);
        }
        insertQuad.run(row[0], row[2], row[4], row[6]);
      }
    })();
    const insertMs = performance.now() - started;
    const subjectKey = rows[4_000]![0] as string;
    const predicateKey = encodeTerm(predicates[0]!).key;
    const subjectStatement = db.prepare(`SELECT s.term_json, p.term_json,
      o.term_json, g.term_json FROM rdf_quads q
      JOIN rdf_terms s ON s.term_key = q.subject_key
      JOIN rdf_terms p ON p.term_key = q.predicate_key
      JOIN rdf_terms o ON o.term_key = q.object_key
      JOIN rdf_terms g ON g.term_key = q.graph_key
      WHERE q.subject_key = ?`);
    const subject = measureQuery(subjectStatement, subjectKey);
    const predicateRows = db
      .prepare('SELECT subject_key FROM rdf_quads WHERE predicate_key = ?')
      .all(predicateKey).length;
    const subjectPlan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM rdf_quads WHERE subject_key = ?',
      )
      .all(subjectKey)
      .map((row) => String((row as { detail: unknown }).detail));
    return {
      name: 'dictionary-prototype',
      bytes: pageBytes(db),
      insertMs: Number(insertMs.toFixed(3)),
      subjectRows: subject.resultRows,
      predicateRows,
      subjectQueryP50Ms: subject.p50Ms,
      subjectPlan,
    };
  } finally {
    db.close();
  }
}

const variants = [
  jsonVariant('v0.1-json-redundant-spog', true),
  jsonVariant('v0.2-json-implicit-spog', false),
  dictionaryVariant(),
];

const baseline = variants[0]!;
const implicit = variants[1]!;
assertSameResults(variants);
if (implicit.bytes >= baseline.bytes) {
  throw new Error('removing the redundant SPOG index did not reduce storage');
}
if (
  !implicit.subjectPlan.some((line) =>
    line.includes('sqlite_autoindex_rdf_quads_1'),
  )
) {
  throw new Error(
    'subject lookup did not use the composite primary-key autoindex',
  );
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dataset: { quads: rows.length, people },
      variants,
      redundantSpogBytesSaved: baseline.bytes - implicit.bytes,
      redundantSpogPercentSaved: Number(
        (((baseline.bytes - implicit.bytes) / baseline.bytes) * 100).toFixed(2),
      ),
    },
    null,
    2,
  ),
);

function assertSameResults(results: VariantResult[]): void {
  const expected = results[0]!;
  for (const result of results.slice(1)) {
    if (
      result.subjectRows !== expected.subjectRows ||
      result.predicateRows !== expected.predicateRows
    ) {
      throw new Error(`${result.name} produced different query results`);
    }
  }
}
