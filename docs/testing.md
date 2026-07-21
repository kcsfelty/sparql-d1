# Testing strategy

The repository uses layered evidence rather than treating one green suite as
proof of the entire system.

| Layer          | Evidence                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Term codec     | Examples plus generated Unicode literal cases                           |
| RDF/JS source  | Every one of the 16 quad-pattern binding masks                          |
| Storage        | Strict schema, uniqueness, named/default graph behavior                 |
| Differential   | Identical Comunica queries over D1 and an N3 reference store            |
| Protocol       | GET/POST, formats, auth, limits, cancellation, SERVICE/LOAD controls    |
| Update         | Explicit opt-in, atomic stream completion, later read visibility        |
| D1             | Miniflare/workerd binding, concurrent writes, batch rollback            |
| Worker runtime | Wrangler dry-run bundle plus local Miniflare/workerd execution          |
| Consumer       | Pack/install exact bytes; import and run the public Worker entry        |
| Application    | Execute the Wikibase-style revision/statement usage example             |
| Performance    | Buffered/paged D1, SPARQL, and storage: latency, CPU, heap, calls, rows |
| Conformance    | 490/490 applicable W3C SPARQL 1.1 manifest cases                        |

Coverage gates are 90% for statements, branches, functions, and lines. Type
declarations and the export-only barrel are excluded because execution
coverage is not meaningful for them.

The conformance job fetches the W3C-maintained manifest and records both a
summary and an RDF EARL report as CI artifacts. Every excluded area and
individual compatibility exception is listed in `docs/conformance.md` and
encoded in the runner. The wrapper also asserts that exactly 490 results were
produced; this prevents an upstream loading fault from becoming an empty green
run.

Complete-site assembly, provisioning, deployment, and hosted acceptance are
outside this repository's test boundary and belong to the agent creating that
site.
The reproducible multi-scenario baseline and interpretation are in
`docs/performance.md`.
The physical-layout benchmark and decision are in
`docs/storage-evaluation.md`.
The definition-of-done evidence map and semantic qualifications are in
`docs/completion-audit.md`; open-source structure and release wiring are
checked by `npm run readiness:check`.
