const Database = require('better-sqlite3');
const { DataFactory } = require('rdf-data-factory');
const {
  QueryResultBindings,
  QueryResultBoolean,
  QueryResultQuads,
} = require('rdf-test-suite');

const dataFactory = new DataFactory();

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async all() {
    const rows = this.database.prepare(this.sql).all(...this.values);
    return { results: rows, success: true, meta: { rows_read: rows.length } };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      results: [],
      success: true,
      meta: { changes: result.changes, rows_written: result.changes },
    };
  }
}

class DatabaseBinding {
  constructor() {
    this.database = new Database(':memory:');
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    return this.database.transaction(() =>
      statements.map((statement) => {
        const result = this.database
          .prepare(statement.sql)
          .run(...statement.values);
        return {
          results: [],
          success: true,
          meta: { changes: result.changes, rows_written: result.changes },
        };
      }),
    )();
  }
}

let modulesPromise;
let queryEngine;

async function modules() {
  modulesPromise ??= Promise.all([
    import('../dist/index.js'),
    import('@comunica/query-sparql'),
  ]);
  const [adapter, comunica] = await modulesPromise;
  queryEngine ??= new comunica.QueryEngine();
  return { ...adapter, ...comunica, queryEngine };
}

async function createStore(data) {
  const { D1QuadStore, initializeStore, insertQuads } = await modules();
  const db = new DatabaseBinding();
  await initializeStore(db);
  await insertQuads(
    db,
    data.map((quad) => {
      if (
        quad.graph.termType === 'NamedNode' &&
        quad.graph.value.startsWith('http://w3c.github.io/')
      ) {
        return dataFactory.quad(
          quad.subject,
          quad.predicate,
          quad.object,
          dataFactory.namedNode(
            quad.graph.value.replace(
              'http://w3c.github.io/',
              'https://w3c.github.io/',
            ),
          ),
        );
      }
      return quad;
    }),
  );
  return { db, source: new D1QuadStore(db) };
}

function context(source, options) {
  const baseIRI = options.baseIRI?.replace(
    'http://w3c.github.io/',
    'https://w3c.github.io/',
  );
  return {
    sources: [source],
    destination: source,
    ...(baseIRI ? { baseIRI } : {}),
  };
}

exports.parse = async (queryString, options) => {
  const { queryEngine } = await modules();
  const { source } = await createStore([]);
  await queryEngine.explain(queryString, context(source, options), 'parsed');
};

exports.query = async (data, queryString, options) => {
  const { queryEngine } = await modules();
  const { source } = await createStore(data);
  const result = await queryEngine.query(queryString, context(source, options));

  if (result.resultType === 'boolean') {
    return new QueryResultBoolean(await result.execute());
  }
  if (result.resultType === 'quads') {
    const stream = await result.execute();
    const quads = [];
    for await (const quad of stream) quads.push(quad);
    return new QueryResultQuads(quads);
  }
  if (result.resultType !== 'bindings') {
    throw new Error(`Unexpected query result type: ${result.resultType}`);
  }

  const metadata = await result.metadata();
  const stream = await result.execute();
  const rows = [];
  for await (const binding of stream) {
    const row = {};
    for (const [variable, term] of binding) row[`?${variable.value}`] = term;
    rows.push(row);
  }
  return new QueryResultBindings(
    metadata.variables.map((variable) => `?${variable.value}`),
    rows,
    false,
  );
};

exports.update = async (data, queryString, options) => {
  const { queryEngine } = await modules();
  const { source } = await createStore(data);
  const queryContext = context(source, options);
  const result = await queryEngine.query(queryString, queryContext);
  if (result.resultType !== 'void') {
    throw new Error(`Unexpected update result type: ${result.resultType}`);
  }
  await result.execute();

  const quads = [];
  for await (const quad of source.match()) quads.push(quad);
  return quads;
};

exports.queryResultFormat = async (data, queryString, mediaType, options) => {
  const { queryEngine } = await modules();
  const { source } = await createStore(data);
  const queryContext = context(source, options);
  const result = await queryEngine.query(queryString, queryContext);
  const serialized = await queryEngine.resultToString(
    result,
    mediaType,
    queryContext,
  );
  return serialized.data;
};
