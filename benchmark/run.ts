import { performance } from 'node:perf_hooks';
import { DataFactory } from 'rdf-data-factory';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import { initializeStore } from '../src/schema.js';
import { MemoryD1 } from '../test/memory-d1.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://benchmark.test/${value}`);
const database = new MemoryD1();
await initializeStore(database);

const quads = Array.from({ length: 5_000 }, (_, index) =>
  factory.quad(
    ex(`person-${index % 1_000}`),
    ex(index % 2 === 0 ? 'name' : 'knows'),
    index % 2 === 0
      ? factory.literal(`Person ${index}`)
      : ex(`person-${(index + 1) % 1_000}`),
  ),
);
for (let offset = 0; offset < quads.length; offset += 1_000) {
  await insertQuads(database, quads.slice(offset, offset + 1_000));
}

let calls = 0;
let rowsRead = 0;
let returnedRows = 0;
let peakHeapBytes = process.memoryUsage().heapUsed;
const source = new D1QuadSource(database, {
  observe(observation) {
    calls += 1;
    rowsRead += Number(observation.metadata?.rows_read ?? 0);
    returnedRows += observation.returnedRows;
  },
});
const durations: number[] = [];
const cpuStarted = process.cpuUsage();

for (let iteration = 0; iteration < 30; iteration += 1) {
  const started = performance.now();
  const stream = source.match(ex(`person-${iteration}`), null, null, null);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', () => undefined);
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  durations.push(performance.now() - started);
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
}

const cpu = process.cpuUsage(cpuStarted);

durations.sort((left, right) => left - right);
const percentile = (value: number) =>
  durations[Math.floor((durations.length - 1) * value)] ?? 0;

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      datasetQuads: quads.length,
      iterations: durations.length,
      sourceCalls: calls,
      rowsRead,
      returnedRows,
      cpuMicroseconds: cpu.user + cpu.system,
      peakHeapBytes,
      latencyMs: {
        p50: Number(percentile(0.5).toFixed(3)),
        p95: Number(percentile(0.95).toFixed(3)),
      },
    },
    null,
    2,
  ),
);

database.close();
