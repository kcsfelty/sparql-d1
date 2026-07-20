import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'benchmark.json';
const report = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(report.schemaVersion, 2);
assert.equal(report.runtime, 'miniflare-workerd-d1');
assert.deepEqual(report.dataset, {
  quads: 5_000,
  defaultGraphQuads: 4_500,
  namedGraphQuads: 500,
});

const expectedRows = new Map([
  ['fully-bound-match', 20],
  ['subject-bound-match', 100],
  ['predicate-default-graph-match', 4_500],
  ['named-graph-match', 2_500],
  ['unbound-full-scan', 15_000],
  ['paginated-unbound-full-scan', 15_000],
  ['count-all', 50_000],
  ['join-with-limit', 200],
  ['filter-with-limit', 500],
  ['aggregate-count', 5],
]);
assert.equal(report.scenarios.length, expectedRows.size);

for (const scenario of report.scenarios) {
  assert.equal(
    scenario.resultRows,
    expectedRows.get(scenario.name),
    `${scenario.name} returned an unexpected semantic result`,
  );
  assert.ok(scenario.d1Calls >= scenario.iterations, scenario.name);
  assert.ok(scenario.d1RowsRead > 0, scenario.name);
  assert.ok(scenario.cpuMicroseconds >= 0, scenario.name);
  assert.ok(scenario.peakHeapBytes > 0, scenario.name);
  assert.ok(scenario.latencyMs.p50 >= 0, scenario.name);
  expectedRows.delete(scenario.name);
}
assert.equal(
  expectedRows.size,
  0,
  'one or more benchmark scenarios are missing',
);
console.log(`validated ${report.scenarios.length} benchmark scenarios`);
