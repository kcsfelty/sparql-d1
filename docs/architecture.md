# Architecture

## Request path

1. A Sites route receives a SPARQL Protocol GET or POST request.
2. The endpoint authenticates the request and enforces byte, algebra, update,
   federation, timeout, and result limits.
3. Comunica parses the query and calls the RDF/JS source with quad patterns.
4. `D1QuadSource` turns bound RDF terms into prepared SQL predicates.
5. D1 returns encoded rows, which the source reconstructs as RDF/JS quads.
6. Comunica evaluates higher-level algebra and serializes the result.

The D1 binding is injected by the host. The package never discovers databases,
stores Cloudflare credentials, or assumes a physical SQLite file.

## Storage

The baseline schema stores a canonical JSON encoding and equality key for each
quad position. This intentionally favors semantic transparency over maximum
storage density. The composite uniqueness autoindex plus three cyclic covering
indexes support subject-, predicate-, object-, and graph-leading lookups. The
former explicit SPOG index was removed after reproducible query-plan and size
evaluation showed it duplicated the uniqueness autoindex.

The canonical representation preserves term type, lexical value, language,
datatype, default/named graph identity, blank-node label, and nested quoted
triple terms. The schema rejects duplicate quads.

## Update model

`D1QuadStore` implements the RDF/JS Store interface. Each insert or delete
stream is accumulated and committed through one atomic SQL statement backed by
SQLite JSON1. This avoids one D1 call per quad and prevents partial writes.
Schema migrations use D1's transactional `batch()` operation. Read-only mode
remains the endpoint default.

`applyQuadPatch()` prepares exact deletions and idempotent insertions, checks
their combined payload before issuing D1 work, and executes them in one D1
batch. Optional required quads act as an optimistic precondition inside that
transaction. This lets an application replace a complete domain-owned RDF
closure while keeping its ontology and invariant logic outside the core store.

When `pageSize` is set, `D1QuadSource` uses deterministic SPOG keyset pages.
Only one bounded page is retained by the source and cancellation prevents the
next page from being issued. A scan is not a cross-page database snapshot:
concurrent changes after the cursor may be observed, while insertions before an
advanced cursor may not be observed. Use application revisions for workflows
that require a stable view.

## Optimization boundary

The reference RDF/JS implementation exposes only `match()` and `countQuads()`.
Comunica's RDF/JS adapter invokes this boundary with individual quad patterns;
it does not deliver basic graph patterns, joins, projections, ordering, or
limits to `sourceFactory`. Consequently SQL algebra pushdown cannot be honestly
implemented behind this option alone.

The endpoint's `sourceFactory` option can switch pattern-read strategies
without forking protocol, authentication, result serialization, or safety
logic. Whole-algebra pushdown would require a separate Comunica query-source
actor or execution-engine integration, with the baseline retained as semantic
oracle. The evidence and no-ship decision are in
`docs/sql-pushdown-decision.md`.
