# Diamond

**SPARQL and atomic RDF storage for Cloudflare D1 and embedded SQLite.**

`@gnolith/diamond` is a TypeScript RDF/JS source and SPARQL Protocol handler
backed by Cloudflare D1. It is designed for Worker applications that need a
standards-based RDF query surface without operating a separate triplestore.

> Status: public experimental release. SPARQL/RDF correctness is extensively
> tested, while the TypeScript API and physical D1 schema may change before
> 1.0. See the [npm package](https://www.npmjs.com/package/@gnolith/diamond)
> and [v0.3.3 release](https://github.com/gnolith/diamond/releases/tag/v0.3.3).

## What it provides

- A lossless RDF/JS term codec, including named graphs and RDF 1.2 quoted
  triple terms.
- A D1-backed RDF/JS `Source` with all 16 bound/unbound quad-pattern shapes.
- An opt-in RDF/JS `Store` with atomic insert/delete streams for SPARQL Update.
- Atomic application-level delete/insert patches with optimistic preconditions.
- Opt-in keyset pagination for bounded-memory D1 pattern reads.
- A Worker-compatible SPARQL HTTP handler with result content negotiation.
- Secure defaults: read-only operation, disabled `SERVICE` and remote `LOAD`,
  bounded query shape, timeout, and serialized-result limits.
- Authentication and observability hooks without prescribing an identity or
  telemetry vendor.
- Differential tests against an in-memory RDF source and integration tests
  against workerd's D1 implementation.
- Additive runtime-neutral SQLite capability names and an isolated embedded
  `node:sqlite` adapter for headless processes and containers.
- Namespaced, checksummed migrations with conservative adoption of exact
  pre-ledger Diamond stores.
- A CI-gated W3C manifest runner with 490/490 applicable SPARQL 1.1 cases
  passing; exclusions are documented rather than hidden.

## Install

Install the public package:

```sh
npm install @gnolith/diamond
```

### Worker runtime requirement

Diamond's published Worker entry points require the Cloudflare Workers
`nodejs_compat` compatibility flag. The RDF/JS Store surface uses
`node:events`, and the query engine includes Node-compatible dependencies.
Configure the flag with a current compatibility date in the Worker project:

```json
{
  "compatibility_date": "2026-07-19",
  "compatibility_flags": ["nodejs_compat"]
}
```

The compatibility date shown is the package's maintained test baseline, not a
requirement to pin applications to that date. Diamond's exact-package consumer
check installs the packed artifact, bundles its public endpoint entry with this
flag, and executes it against an ephemeral D1 binding in Miniflare/workerd.

Maintainers validating an unreleased commit can run `npm pack` and install the
resulting archive. Do not install the Git repository directly: generated
`dist` files are not committed.

Apply the numbered files in `migrations/` to the application's D1 database in order
before serving queries. Existing `0.1.x` stores must apply
`0002_drop_redundant_spog.sql` before using atomic patch preconditions.
New applications may instead call `initializeStore()`, which applies Diamond's
checksummed migration history to either D1 or the embedded Node adapter. See
[embedded SQLite and migrations](docs/embedded-sqlite.md).

## SPARQL HTTP handler

After enabling `nodejs_compat`, create the handler once at module scope with the
D1-compatible binding supplied by the host application:

```ts
import { createSparqlHandler } from '@gnolith/diamond/endpoint';

const handle = createSparqlHandler({
  db,
  authenticate(request) {
    return authorize(request);
  },
});
```

The host application owns route assembly, binding and secret provisioning,
deployment, and hosted acceptance. Diamond's repository checks only the
published package and its supported local runtimes.

Read-only mode and `SERVICE` rejection are enabled by default. Set
`readOnly: false` only for an authenticated administrative endpoint. Federation
requires a `servicePolicy`; use `allowServiceUrls()` for a strict static
allowlist. Remote SPARQL `LOAD` is not supported by the HTTP handler, including
on writable endpoints; import trusted RDF through an application-controlled
path instead.

For mixed access, expose separate handlers: keep `/api/sparql` read-only and
put a `readOnly: false` handler behind stronger administrator authentication at
a separate route such as `/api/sparql/admin`. The authentication hook protects
one complete handler; the package intentionally does not invent an identity or
role system for the host application.

## Use as an RDF/JS source

```ts
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { D1QuadSource } from '@gnolith/diamond';

const source = new D1QuadSource(env.DB);
const engine = new QueryEngine();
const bindings = await engine.queryBindings(
  'SELECT * WHERE { ?subject ?predicate ?object } LIMIT 100',
  { sources: [source] },
);
```

Set `pageSize` on `D1QuadSource`, or `sourcePageSize` on the HTTP handler, to
read broad patterns in bounded keyset pages. The default remains the original
single-read semantic baseline.

For a process-local file or `:memory:` database, import
`NodeSqliteDatabase` from the isolated `@gnolith/diamond/node-sqlite` subpath.
The root and Worker entry points do not import `node:sqlite`. The adapter is an
embedded connection, not a server; the host owns file selection and process
lifecycle.

For domain edits that replace related RDF facts together, use
`applyQuadPatch(db, { require, delete, insert })`. The Wikibase-style example
under `examples/` demonstrates ranked statements, qualifiers, references,
truthy triples, and optimistic entity revisions as application behavior; it
does not depend on Wikipedia, Wikidata, or Wikibase.
Use `prepareQuadPatch()` when the same RDF patch must share one atomic D1 batch
with application-owned rows.

## Security

The package prevents SPARQL Update and federated `SERVICE` execution unless
explicitly enabled, and rejects remote `LOAD` even in writable mode. It does
not authenticate callers or impose a distributed rate limit automatically;
those controls depend on the host application and must be supplied through the
authentication hook and deployment platform.

See [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md)
before exposing an endpoint publicly.

See [docs/api.md](docs/api.md) for every export, option, default, and runtime
behavior.

## Development

```sh
npm ci
npm run check
npm run conformance
npm run benchmark:check
npm run benchmark:storage:check
```

`npm run check` formats, lints, type-checks, executes coverage and local D1
integration tests, builds the package, bundles a module-Worker fixture with
Wrangler in dry-run mode, executes it in Miniflare/workerd, and inspects the
exact npm artifact. It does not deploy or qualify a complete application site.

The independent exact-package consumer procedure is in
[docs/integration-validation.md](docs/integration-validation.md).
The workerd D1 and Comunica performance baseline is in
[docs/performance.md](docs/performance.md).

RDF writes use a single JSON-backed SQLite statement, keeping an update atomic
and avoiding one D1 subrequest per quad. A single atomic payload is capped at
1.9 MB to leave headroom below D1's 2 MB bound-value limit; larger imports must
be split deliberately by the host application.

## Current limitations

- The default source buffers each individual D1 pattern result. Opt-in keyset
  pagination bounds rows held by the source, but is not a snapshot across pages.
- SPARQL joins are evaluated by Comunica. The RDF/JS `sourceFactory` receives
  quad patterns, not whole query algebra, so SQL join pushdown requires a
  different Comunica integration boundary; see
  [docs/sql-pushdown-decision.md](docs/sql-pushdown-decision.md).
- The package stores RDF in its own quad table. It does not infer RDF mappings
  from arbitrary relational application tables.
- Entailment regimes and the Graph Store HTTP Protocol are out of scope for the
  initial release.
- Remote SPARQL `LOAD` is intentionally unavailable at the HTTP boundary to
  prevent writable endpoints from becoming unrestricted server-side fetchers.
- The full Comunica engine produces a roughly 6.1 MB uncompressed Worker bundle
  (about 990 KB gzip in the current dry run).
  The package imports its static engine entry point directly so Components.js
  filesystem configuration is not evaluated in Workers.

Public-release controls and remaining operational follow-ups are tracked in
[docs/open-source-readiness.md](docs/open-source-readiness.md).

## License

MIT
