# sparql-d1

`sparql-d1` is a TypeScript RDF/JS source and SPARQL Protocol handler backed by
Cloudflare D1. It is designed for Cloudflare Workers and Codex Sites projects
that need a standards-based RDF query surface without operating a separate
triplestore.

> Status: private pre-release. The API, schema, and package name may change
> before the first public release.

## What it provides

- A lossless RDF/JS term codec, including named graphs and RDF 1.2 quoted
  triple terms.
- A D1-backed RDF/JS `Source` with all 16 bound/unbound quad-pattern shapes.
- An opt-in RDF/JS `Store` with atomic insert/delete streams for SPARQL Update.
- A Worker-compatible SPARQL HTTP handler with result content negotiation.
- Secure defaults: read-only operation, disabled `SERVICE`, bounded query
  shape, timeout, and serialized-result limits.
- Authentication and observability hooks without prescribing an identity or
  telemetry vendor.
- Differential tests against an in-memory RDF source and integration tests
  against workerd's D1 implementation.
- A CI-gated W3C manifest runner with 490/490 applicable SPARQL 1.1 cases
  passing; exclusions are documented rather than hidden.

## Install

The package is not published while the repository remains private. Build a
tarball from an authorized clean clone:

```sh
npm ci
npm pack
# Then, from the Sites project:
npm install ./vendor/sparql-d1-0.0.0.tgz
```

Do not install the Git repository directly: generated `dist` files are not
committed. After the public release, installation will be `npm install
sparql-d1`.

Apply `migrations/0001_rdf_quads.sql` to the site's D1 database before serving
queries.

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
allowlist.

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

## Security

The package prevents SPARQL Update and federated `SERVICE` execution unless
explicitly enabled. It does not authenticate callers or impose a distributed
rate limit automatically; those controls depend on the host application and
must be supplied through the authentication hook and deployment platform.

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

- The baseline source buffers each individual D1 pattern result before handing
  it to Comunica. Final HTTP serialization is streamed and bounded.
- SPARQL joins are evaluated by Comunica. SQL algebra pushdown is a planned
  optimization and must remain semantically equivalent to this baseline.
- The package stores RDF in its own quad table. It does not infer RDF mappings
  from arbitrary relational application tables.
- Entailment regimes and the Graph Store HTTP Protocol are out of scope for the
  initial release.
- The full Comunica engine produces a roughly 6.1 MB uncompressed Worker bundle
  (about 990 KB gzip in the current dry run).
  The package imports its static engine entry point directly so Components.js
  filesystem configuration is not evaluated in Workers.

The current private-to-public release gates are tracked in
[docs/open-source-readiness.md](docs/open-source-readiness.md).

## License

MIT
