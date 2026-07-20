# RDF storage evaluation

Issue #6 was evaluated with `npm run benchmark:storage:check`. The command
builds three deterministic SQLite databases containing 8,000 quads with the
same repeated term shapes, confirms equivalent subject- and predicate-bound
results, records storage and query plans, and fails if the chosen index removal
loses its primary-key plan.

## Recorded result (2026-07-20)

| Variant                      |      Bytes | Insert ms | Subject p50 ms | Decision |
| ---------------------------- | ---------: | --------: | -------------: | -------- |
| v0.1 JSON plus explicit SPOG | 14,036,992 |    67.546 |         0.0055 | Baseline |
| JSON plus implicit SPOG      | 11,997,184 |    59.284 |         0.0054 | Ship     |
| Dictionary prototype         |  8,773,632 |    73.718 |         0.0041 | Defer    |

Times describe one local Node 24 / SQLite run and are comparison evidence, not
hosted-D1 latency guarantees. Semantic row counts and plans are deterministic.
Removing `rdf_quads_spog_idx` saved 2,039,808 bytes (14.53%) in this workload.
SQLite planned the same subject lookup through
`sqlite_autoindex_rdf_quads_1`, which is owned by the table's composite UNIQUE
constraint. A workerd D1 integration assertion confirms the same
`EXPLAIN QUERY PLAN` choice. Migration `0002_drop_redundant_spog.sql` removes
only that duplicate index, and schema inspection now verifies the autoindex plus
the three distinct cyclic indexes.

The dictionary prototype reduced storage further, but it changes every read
and write, adds four decode joins, makes online migration and rollback more
complex, and measured slower insertion in this workload. Shipping it before a
D1-specific migration, all-pattern rows-read, Worker CPU/memory, collision,
rollback, and conformance study would trade a proven representation for an
incomplete optimization. It is therefore deliberately deferred rather than
silently becoming the pre-1.0 schema.

The existing workerd benchmark and all 16 RDF/JS pattern tests remain the
semantic/performance oracle. Future compact-key or dictionary work must add a
versioned migration and pass those gates before selection.
