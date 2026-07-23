# @gnolith/diamond

Diamond is a transport-neutral SPARQL executor and atomic RDF/JS store for
Cloudflare D1-compatible and embedded SQLite connections.

Version 0.5.0 is an architecture reset. Diamond does not expose an HTTP handler,
route, authentication, CORS, or rate-limiting layer. Applications such as
Workshop authorize their own transport requests and pass only an operation,
SPARQL text, result preference, cancellation signal, and execution policy to
Diamond.

## Install

```sh
npm install @gnolith/diamond
```

Node 22 or later is required only for the optional native adapter and package
test harness. The root storage graph and `./sparql` graph do not import
`node:sqlite`.

## Storage

```ts
import {
  D1QuadSource,
  initializeStore,
  prepareQuadPatch,
  statementsForQuadPatch,
} from '@gnolith/diamond';

await initializeStore(db);
const source = new D1QuadSource(db, { pageSize: 500 });
const plan = prepareQuadPatch(db, { insert: quads });
const results = await db.batch([
  ownerStatement,
  ...statementsForQuadPatch(db, plan),
]);
const change = plan.readResult(results, 1);
```

Plans are frozen, privately branded, and bound to the exact connection that
prepared them. Use `statementsForQuadPatch()` at the transaction-composition
boundary; forged, serialized, and cross-connection plans are rejected.

## SPARQL execution

```ts
import { createSparqlExecutor } from '@gnolith/diamond/sparql';

const execute = createSparqlExecutor({
  db,
  policy: {
    readOnly: true,
    maxQueryBytes: 16_384,
    maxResultBytes: 5_242_880,
    timeoutMs: 10_000,
  },
});

const result = await execute({
  operation: 'query',
  text: 'SELECT * WHERE { ?s ?p ?o } LIMIT 100',
  accept: 'application/sparql-results+json',
  signal,
});
```

The default is read-only and federation-disabled. `LOAD`, dynamic `SERVICE`
targets, credential-bearing URLs, unapproved targets, and redirects are
rejected. A host that enables federation must authorize each exact outbound
target.

## Migration ownership and backup

The shared `_gnolith_migrations` table is namespaced. Owners register an ordered
manifest with a connection- and installation-bound assembly authority.
Privately branded handles are then required for namespace-sliced evidence and
restore operations. Slices use JCS canonicalization and SHA-256.

`@gnolith/diamond/backup` exports and imports only Diamond's `rdf_quads`,
`rdf_patch_guards`, and Diamond ledger slice. Checksums are verified before
inspection or mutation; foreign tables and ledger namespaces are untouched.
Rebuild mode returns an explicit `rebuild-required` report and never silently
drops RDF.

Exact 0.4.1 sources can be decoded through the read-only
`decodeDiamond041LegacyOwnerV1()` compatibility seam. It requires an exact
package/version attestation, inspects only fixed Diamond-owned legacy objects
and namespace evidence, and emits a bounded privately branded owner fragment
for `adoptDiamond041LegacyOwnerV1()`.

See [the 0.5 migration guide](docs/migrating-to-0.5.md), [API reference](docs/api.md),
[threat model](docs/threat-model.md), and [embedded SQLite guide](docs/embedded-sqlite.md).

## Verification

```sh
npm ci
npm check
```

The full gate runs formatting, linting, type checks, coverage, builds, examples,
packed-artifact inventory, packed-consumer execution, license policy, and
readiness checks. It creates no hosted resource.

Licensed under MIT.
