# Testing strategy

The repository uses layered evidence rather than treating one green suite as
proof of the entire system.

| Layer         | Evidence                                                            |
| ------------- | ------------------------------------------------------------------- |
| Term codec    | Examples plus generated Unicode literal cases                       |
| RDF/JS source | Every one of the 16 quad-pattern binding masks                      |
| Storage       | Strict schema, uniqueness, named/default graph behavior             |
| Differential  | Identical Comunica queries over D1 and an N3 reference store        |
| Protocol      | GET, POST, formats, status codes, limits, auth, federation policy   |
| Update        | Explicit opt-in, transaction completion, subsequent read visibility |
| D1            | Miniflare/workerd binding, concurrent writes, batch rollback        |
| Deployment    | Wrangler Worker dry-run bundle with `nodejs_compat`                 |
| Performance   | Deterministic dataset, p50/p95 latency, source-call count           |
| Conformance   | 490/490 applicable W3C SPARQL 1.1 manifest cases                    |

Coverage gates are 90% for statements, branches, functions, and lines. Type
declarations and the export-only barrel are excluded because execution
coverage is not meaningful for them.

The conformance job fetches the W3C-maintained manifest and records both a
summary and an RDF EARL report as CI artifacts. Every excluded area and
individual compatibility exception is listed in `docs/conformance.md` and
encoded in the command line.
