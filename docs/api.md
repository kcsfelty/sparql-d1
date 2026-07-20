# API reference

All APIs are ESM and require Node.js 22 or a compatible Workers runtime.

## Endpoint

### `createSparqlHandler(options)`

Creates one reusable `(request: Request) => Promise<Response>` handler.

Required option:

- `db`: a D1-compatible binding.

Security and lifecycle options:

| Option                 | Default  | Meaning                                                                 |
| ---------------------- | -------- | ----------------------------------------------------------------------- |
| `readOnly`             | `true`   | Use a Source and reject SPARQL Update.                                  |
| `authenticate`         | none     | Return `true`, `false`, or a complete response.                         |
| `rateLimit`            | none     | Return a complete response, normally HTTP 429, to stop before parsing.  |
| `servicePolicy`        | none     | Authorize each static `SERVICE` URL; without it federation is rejected. |
| `serviceFetch`         | global   | Fetch-compatible federation transport, still wrapped by the policy.     |
| `sourceFactory`        | baseline | Construct an alternative RDF/JS pattern source.                         |
| `sourcePageSize`       | unset    | Enable deterministic keyset pages with this maximum page size.          |
| `maxQueryBytes`        | 16 KiB   | Maximum UTF-8 query/update size.                                        |
| `maxResultBytes`       | 5 MiB    | Maximum streamed serialized body size.                                  |
| `maxAlgebraDepth`      | 40       | Maximum parsed algebra nesting depth.                                   |
| `maxAlgebraOperations` | 250      | Maximum counted algebra operations.                                     |
| `timeoutMs`            | 10,000   | Shared parse/query/serialization deadline.                              |
| `exposeErrors`         | `false`  | Reveal unexpected internal error messages.                              |

`observe` receives request-level status, duration, query bytes, result type,
media type, and an error message. `observeD1` receives each source operation,
bound-position count, duration, returned rows, and D1 metadata such as
`rows_read` when the runtime supplies it.

`sourceFactory(db, { readOnly, observe, pageSize })` is invoked once when the handler is
created. A read-only implementation returns an RDF/JS Source; a writable
implementation must satisfy the RDF/JS Store operations used by Comunica. This
can select pattern-read behavior such as pagination or alternate physical
storage. It does not receive whole SPARQL algebra and is therefore not, by
itself, a join-pushdown boundary. See `docs/sql-pushdown-decision.md`.

The handler honors `request.signal`, passes it to Comunica for HTTP activity,
and returns status 499 if the request is cancelled before a response begins.
Cancelling a response body stops its result iterator. D1 does not expose a
per-statement cancellation API, so an already-issued D1 statement may still
finish inside the platform.

The default engine is imported through Comunica's static engine entry point so
the Node-only Components.js factory is not evaluated in Workers. A
`servicePolicy` remains mandatory for every federated target.

Bindings and boolean results support SPARQL Results JSON, SPARQL Results XML,
CSV, and TSV. RDF results support Turtle, N-Triples, N-Quads, TriG, and JSON-LD.
HTTP `Accept` negotiation honors exact types, `type/*` and `*/*` ranges,
quality weights, and exact `q=0` exclusions. The defaults are SPARQL Results
JSON and Turtle; an unacceptable request receives HTTP 406.

GET requires the `query` parameter; unrelated query parameters are currently
ignored. Updates require POST with either
`application/sparql-update` or exactly one form-encoded `update` field. Query
and update media types are not interchangeable, even when writable mode is
enabled; ambiguous or disguised operations receive HTTP 400.

Remote SPARQL `LOAD` receives HTTP 403 even when `readOnly: false`. `LOAD`
would turn a writable endpoint into a server-side network fetch surface, so
trusted RDF imports must use an application-controlled path. Local update
forms such as `INSERT DATA`, `DELETE DATA`, and graph mutation remain available
when writable mode is explicitly enabled.

### `allowServiceUrls(urls)`

Builds an exact, canonical URL allowlist for `servicePolicy`. Dynamic
`SERVICE ?variable` targets, credential-bearing URLs, and non-HTTP(S) URLs are
always rejected before the policy is called. Comunica's outbound fetch is
wrapped so every requested URL is reauthorized and HTTP redirects are rejected;
an allowed origin cannot redirect the Worker to a second, unreviewed target.

## RDF storage

### `D1QuadSource`

Implements RDF/JS `Source`. `match()` and `countQuads()` accept the four RDF/JS
quad positions; `null`, `undefined`, and variables are unbound. Matching is
performed with fixed prepared SQL and canonical term keys.

`new D1QuadSource(db, { pageSize })` enables deterministic SPOG keyset
pagination. Each D1 read requests at most `pageSize + 1` rows, the iterator
retains at most one page, and cancellation stops later page requests. Page
observations include `readMode`, `page`, and `pageSize`. Without `pageSize`, a
pattern uses the original single `.all()` call. Pagination has read-committed
page semantics rather than a snapshot spanning the entire iterator; concurrent
inserts before the cursor can be missed and changes after it can be observed.

### `D1QuadStore`

Extends the source with RDF/JS Store `import`, `remove`, `removeMatches`, and
`deleteGraph`. A complete input stream is committed as one atomic JSON1-backed
statement. The endpoint only constructs this Store when `readOnly: false`.

For deployments offering both general reads and administrative writes, prefer
separate read-only and authenticated writable handlers. `authenticate`
protects the complete handler; authorization roles remain a host concern.

### Write helpers

- `insertQuads(db, quads)` inserts a set of quads and returns the D1 change count.
- `deleteQuads(db, quads)` deletes exact quads.
- `deleteMatchingQuads(db, s, p, o, g)` deletes a pattern.
- `applyQuadPatch(db, { require?, delete?, insert? })` validates the aggregate
  payload, then performs exact deletion followed by idempotent insertion in one
  D1 transaction. It returns `{ deleted, inserted }`. If any `require` quad is
  absent at transaction start, neither side changes and the helper throws
  `QuadPatchConflictError`. Required quads are useful for optimistic revision
  guards; an otherwise empty patch is a no-op rather than a precondition probe.

Atomic write payloads are limited to 1.9 MB, leaving headroom below D1's 2 MB
bound-value limit. Split larger imports at the application boundary.
For a patch, the combined encoded `require`, `delete`, and `insert` payloads
share that limit and are validated before D1 is touched. Apply migration
`0002_drop_redundant_spog.sql` before using patch preconditions on an existing
`0.1.x` store.

## Schema and codec

- `initializeStore(db)` applies the idempotent schema statements through
  transactional D1 `batch()`.
- `schemaStatements` exposes those statements for migration tooling.
- `inspectStoreSchema(db)` reads only the `rdf_quads` SQLite catalog entries
  and reports table/patch-guard strictness, expected index column order, and validation
  errors. It is intended for controlled deployment verification, not a public
  application endpoint.
- `encodeTerm(term)` and `decodeTerm(json)` provide the canonical lossless term
  representation used by the table.

The structural D1 interfaces—`D1DatabaseLike`, `D1PreparedStatementLike`, and
`D1ResultLike`—allow local emulators and test doubles without importing
Cloudflare's ambient types.
