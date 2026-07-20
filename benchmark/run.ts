import { performance } from 'node:perf_hooks';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import type * as RDF from '@rdfjs/types';
import { Miniflare } from 'miniflare';
import { DataFactory } from 'rdf-data-factory';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import type { QueryObservation } from '../src/d1-source.js';
import type { D1DatabaseLike } from '../src/d1-types.js';
import { initializeStore } from '../src/schema.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://benchmark.test/${value}`);
const defaultGraph = factory.defaultGraph();
const namedGraph = ex('graph/people');
const predicates = {
  type: ex('type'),
  name: ex('name'),
  group: ex('group'),
  knows: ex('knows'),
  score: ex('score'),
};

const people = 1_000;
const quads = Array.from({ length: people }, (_, person) => {
  const subject = ex(`person-${person}`);
  const graph = person % 10 === 0 ? namedGraph : defaultGraph;
  return [
    factory.quad(subject, predicates.type, ex('Person'), graph),
    factory.quad(
      subject,
      predicates.name,
      factory.literal(`Person ${person}`),
      graph,
    ),
    factory.quad(subject, predicates.group, ex(`group-${person % 20}`), graph),
    factory.quad(
      subject,
      predicates.knows,
      ex(`person-${(person + 1) % people}`),
      graph,
    ),
    factory.quad(
      subject,
      predicates.score,
      factory.literal(
        String(person),
        factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
      ),
      graph,
    ),
  ];
}).flat();

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-19',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'diamond-benchmark' },
});

interface ScenarioResult {
  name: string;
  layer: 'rdfjs-source' | 'sparql';
  iterations: number;
  resultRows: number;
  d1Calls: number;
  d1RowsRead: number;
  d1DurationMs: number;
  cpuMicroseconds: number;
  peakHeapBytes: number;
  heapGrowthBytes: number;
  latencyMs: { cold: number; p50: number; p95: number };
}

let activeObservations: QueryObservation[] | undefined;

function collect(stream: RDF.Stream<RDF.Quad>): Promise<number> {
  return new Promise((resolve, reject) => {
    let rows = 0;
    stream.on('data', () => (rows += 1));
    stream.on('end', () => resolve(rows));
    stream.on('error', reject);
  });
}

function percentile(sorted: number[], value: number): number {
  return sorted[Math.floor((sorted.length - 1) * value)] ?? 0;
}

async function measure(
  name: string,
  layer: ScenarioResult['layer'],
  iterations: number,
  operation: () => Promise<number>,
): Promise<ScenarioResult> {
  const observations: QueryObservation[] = [];
  const durations: number[] = [];
  const heapStarted = process.memoryUsage().heapUsed;
  let peakHeapBytes = heapStarted;
  let resultRows = 0;
  activeObservations = observations;
  const cpuStarted = process.cpuUsage();

  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now();
      resultRows += await operation();
      durations.push(performance.now() - started);
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    }
  } finally {
    activeObservations = undefined;
  }

  const cpu = process.cpuUsage(cpuStarted);
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    name,
    layer,
    iterations,
    resultRows,
    d1Calls: observations.length,
    d1RowsRead: observations.reduce(
      (total, item) => total + Number(item.metadata?.rows_read ?? 0),
      0,
    ),
    d1DurationMs: Number(
      observations
        .reduce((total, item) => total + item.durationMs, 0)
        .toFixed(3),
    ),
    cpuMicroseconds: cpu.user + cpu.system,
    peakHeapBytes,
    heapGrowthBytes: Math.max(0, peakHeapBytes - heapStarted),
    latencyMs: {
      cold: Number((durations[0] ?? 0).toFixed(3)),
      p50: Number(percentile(sorted, 0.5).toFixed(3)),
      p95: Number(percentile(sorted, 0.95).toFixed(3)),
    },
  };
}

try {
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  await initializeStore(db);
  for (let offset = 0; offset < quads.length; offset += 1_000) {
    await insertQuads(db, quads.slice(offset, offset + 1_000));
  }

  const source = new D1QuadSource(db, {
    observe(observation) {
      activeObservations?.push(observation);
    },
  });
  const paginatedSource = new D1QuadSource(db, {
    pageSize: 256,
    observe(observation) {
      activeObservations?.push(observation);
    },
  });
  const engine = new QueryEngine();
  const scenarios: ScenarioResult[] = [];
  const subject = ex('person-1');

  scenarios.push(
    await measure('fully-bound-match', 'rdfjs-source', 20, () =>
      collect(
        source.match(
          subject,
          predicates.name,
          factory.literal('Person 1'),
          defaultGraph,
        ),
      ),
    ),
    await measure('subject-bound-match', 'rdfjs-source', 20, () =>
      collect(source.match(subject)),
    ),
    await measure('predicate-default-graph-match', 'rdfjs-source', 5, () =>
      collect(source.match(null, predicates.type, null, defaultGraph)),
    ),
    await measure('named-graph-match', 'rdfjs-source', 5, () =>
      collect(source.match(null, null, null, namedGraph)),
    ),
    await measure('unbound-full-scan', 'rdfjs-source', 3, () =>
      collect(source.match()),
    ),
    await measure('paginated-unbound-full-scan', 'rdfjs-source', 3, () =>
      collect(paginatedSource.match()),
    ),
    await measure('count-all', 'rdfjs-source', 10, () => source.countQuads()),
  );

  const bindings = async (query: string) => {
    const stream = await engine.queryBindings(query, { sources: [source] });
    return (await stream.toArray()).length;
  };
  scenarios.push(
    await measure('join-with-limit', 'sparql', 2, () =>
      bindings(`SELECT ?person ?name WHERE {
        ?person <${predicates.type.value}> <${ex('Person').value}>;
                <${predicates.name.value}> ?name.
      } LIMIT 100`),
    ),
    await measure('filter-with-limit', 'sparql', 5, () =>
      bindings(`SELECT ?person ?name WHERE {
        ?person <${predicates.name.value}> ?name.
        FILTER(CONTAINS(STR(?name), "Person"))
      } LIMIT 100`),
    ),
    await measure('aggregate-count', 'sparql', 5, () =>
      bindings(`SELECT (COUNT(?person) AS ?count) WHERE {
        ?person <${predicates.type.value}> <${ex('Person').value}>.
      }`),
    ),
  );

  console.log(
    JSON.stringify(
      {
        schemaVersion: 2,
        runtime: 'miniflare-workerd-d1',
        dataset: {
          quads: quads.length,
          defaultGraphQuads: 4_500,
          namedGraphQuads: 500,
        },
        scenarios,
      },
      null,
      2,
    ),
  );
} finally {
  await miniflare.dispose();
}
