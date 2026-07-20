# sparql-d1

`sparql-d1` is a TypeScript RDF/JS source and SPARQL Protocol handler backed by
Cloudflare D1. It is designed for Cloudflare Workers and Codex Sites projects
that need a standards-based RDF query surface without operating a separate
triplestore.

> Status: public experimental release. SPARQL/RDF correctness is extensively
> tested, while the TypeScript API and physical D1 schema may change before
> 1.0. See the [npm package](https://www.npmjs.com/package/sparql-d1) and
> [v0.2.0 release](https://github.com/kcsfelty/sparql-d1/releases/tag/v0.2.0).

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
- A CI-gated W3C manifest runner with 490/490 applicable SPARQL 1.1 cases
  passing; exclusions are documented rather than hidden.

## Install

Install the public package:

```sh
npm install sparql-d1
```

Maintainers validating an unreleased commit can run `npm pack` and install the
resulting archive. Do not install the Git repository directly: generated
`dist` files are not committed.

Apply the numbered files in `migrations/` to the site's D1 database in order
before serving queries. Existing `0.1.x` stores must apply
`0002_drop_redundant_spog.sql` before using atomic patch preconditions.

## Codex Sites route

Declare the logical binding in `.openai/hosting.json`:

```json
{
  "d1": "DB",
  "r2": null
}
```

Then create a route whose handler is initialized once at module scope:

```ts
import { env } from 'cloudflare:workers';
import { createSparqlHandler } from 'sparql-d1/endpoint';

const handle = createSparqlHandler({
  db: env.DB,
  authenticate(request) {
    return (
      request.headers.get('authorization') === `Bearer ${env.SPARQL_TOKEN}`
    );
  },
});

export const GET = handle;
export const POST = handle;
```

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
import { D1QuadSource } from 'sparql-d1';

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

For domain edits that replace related RDF facts together, use
`applyQuadPatch(db, { require, delete, insert })`. The Wikibase-style example
under `examples/codex-site` demonstrates ranked statements, qualifiers,
references, truthy triples, and optimistic entity revisions as site-owned
application behavior; it does not depend on Wikipedia, Wikidata, or Wikibase.

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

`npm run check` formats, lints, type-checks, executes coverage and D1
integration tests, builds the package, bundles a Cloudflare Worker, and
inspects the npm artifact.

The production Codex Sites and D1 acceptance record, including a reusable
probe, is in [docs/deployed-e2e.md](docs/deployed-e2e.md).
The independent clean-project procedure is in
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
