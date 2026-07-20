# Performance baseline

`npm run benchmark:check` creates a deterministic 5,000-quad dataset in Miniflare's
workerd D1 runtime. It measures the exact RDF/JS pattern calls that Comunica
emits as well as join, filter, limit, and aggregate queries. The JSON output is
written to `benchmark.json` and validated for all expected semantic results;
it is the comparison artifact for future storage or SQL-pushdown implementations.

## Baseline recorded 2026-07-19

This run used Node.js 24.14.0 on the local validation host. Times are useful for
regression comparisons on comparable hardware, not as hosted-D1 guarantees.
Counts and semantic results are deterministic.

| Scenario                  | Iterations | Result rows | D1 calls | D1 rows read |  CPU µs |  p50 ms |  p95 ms |
| ------------------------- | ---------: | ----------: | -------: | -----------: | ------: | ------: | ------: |
| Fully bound match         |         20 |          20 |       20 |           20 | 343,000 |  76.509 |  79.518 |
| Subject-bound match       |         20 |         100 |       20 |          120 | 126,000 |  77.769 |  80.768 |
| Predicate + default graph |          5 |       4,500 |        5 |       22,505 |  15,000 |  91.654 |  92.701 |
| Named graph               |          5 |       2,500 |        5 |        2,500 |  79,000 |  75.987 |  79.014 |
| Unbound full scan         |          3 |      15,000 |        3 |       15,000 | 125,000 | 125.400 | 125.400 |
| Count all                 |         10 |      50,000 |       10 |       50,000 |  31,000 |  76.528 |  83.287 |
| SPARQL join + limit       |          2 |         200 |        8 |       21,608 |  78,000 | 335.149 | 335.149 |
| SPARQL filter + limit     |          5 |         500 |       10 |       45,010 | 234,000 | 168.438 | 168.767 |
| SPARQL aggregate          |          5 |           5 |       10 |        9,010 | 125,000 | 168.221 | 172.307 |

The run also records absolute peak heap and heap growth for every scenario in
its JSON output. Observed peak heap ranged from about 97 MB to 140 MB; the
largest per-scenario growth was about 46 MB for the aggregate case. Garbage
collection timing makes heap figures noisier than call and row counts.

## Interpretation

Fully bound, subject-leading, and graph-leading access use the intended
covering indexes. Predicate-plus-graph access currently reads the 4,500-row
default graph to return 900 type rows per iteration. Comunica's filter and
limit are evaluated above the source, so they do not reduce the baseline D1
read set. These are documented costs, not hidden benchmark exclusions.

An optimization is acceptable only when it:

1. runs the same scenario dataset and query text;
2. passes the differential and W3C suites unchanged;
3. reports lower D1 calls, rows read, CPU, memory, or latency without worsening
   another metric outside an explicitly reviewed tradeoff; and
4. retains the simple RDF/JS implementation as an oracle until the optimized
   path has equivalent evidence.

The real Codex Sites timings, including cold-engine behavior, are recorded in
`docs/deployed-e2e.md` because local workerd timings do not substitute for a
deployed Worker measurement.
