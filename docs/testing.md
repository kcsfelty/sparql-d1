# Testing strategy

The repository uses layered evidence rather than treating one green suite as
proof of the entire system.

| Layer         | Evidence                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Term codec    | Examples plus generated Unicode literal cases                          |
| RDF/JS source | Every one of the 16 quad-pattern binding masks                         |
| Storage       | Strict schema, uniqueness, named/default graph behavior                |
| Differential  | Identical Comunica queries over D1 and an N3 reference store           |
| Protocol      | GET/POST, formats, auth, rate limit, cancellation, SERVICE policy      |
| Update        | Explicit opt-in, atomic stream completion, later read visibility       |
| D1            | Miniflare/workerd binding, concurrent writes, batch rollback           |
| Deployment    | Worker dry-run plus real Codex Sites HTTP and managed-D1 sequence      |
| Consumer      | Install the packed tarball and import both public entry points         |
| Performance   | Workerd D1 patterns and SPARQL shapes: latency, CPU, heap, calls, rows |
| Conformance   | 490/490 applicable W3C SPARQL 1.1 manifest cases                       |

Coverage gates are 90% for statements, branches, functions, and lines. Type
declarations and the export-only barrel are excluded because execution
coverage is not meaningful for them.

The conformance job fetches the W3C-maintained manifest and records both a
summary and an RDF EARL report as CI artifacts. Every excluded area and
individual compatibility exception is listed in `docs/conformance.md` and
encoded in the runner. The wrapper also asserts that exactly 490 results were
produced; this prevents an upstream loading fault from becoming an empty green
run.

The dated deployed acceptance evidence and rerun command are recorded in
`docs/deployed-e2e.md`.
The reproducible multi-scenario baseline and interpretation are in
`docs/performance.md`.
