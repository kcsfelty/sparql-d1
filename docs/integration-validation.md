# Independent Codex Sites integration validation

This checklist is executable by a consumer or an independent validator who did
not author the package. Record the validator, date, installed package version,
Sites starter version, and every documentation correction in the pull request
or issue used for sign-off.

## Consumer setup

Start in a fresh directory and new Codex task with no inherited project context.
Create a new Codex Sites project and install the public package:

```sh
npm install @gnolith/diamond
```

Do not install the Git repository directly; generated `dist` files are
deliberately not committed. An agent validator should receive the prompt in
`docs/clean-room-agent-prompt.md` with the version and evidence-output location
filled in.

## Maintainer validation of an unreleased build

For an unreleased commit, the maintainer runs `npm ci`, `npm run check`, and
`npm pack`, records the archive SHA-256, and gives an independent validator only
that archive plus public-facing documentation. The validator installs the exact
archive from a `vendor/` directory:

```sh
npm install ./vendor/gnolith-diamond-<version>.tgz
```

Do not give the validator an existing checkout, configured Site, implementation
discussion, or unpublished workaround. This artifact workflow validates bytes
before publication; ordinary consumers should use npm.

## Add the endpoint

Copy these paths from `examples/codex-site`, preserving their relative paths:

- `.openai/hosting.json`
- `app/api/sparql/route.ts`
- `app/api/sparql/admin/route.ts` only for temporary writable validation
- `app/api/sparql/schema/route.ts` only for temporary managed-schema validation
- `drizzle/0000_rdf_quads.sql`
- `drizzle/0001_drop_redundant_spog.sql`

Set the secret runtime value `SPARQL_TOKEN`. Keep the site owner-only during
validation, then build and deploy through the normal Codex Sites workflow.

The Sites deployment flow applies the copied Drizzle migration to managed D1.
The current Sites starter does not expose a package-documented command for
applying that migration to the fresh D1 used by `vinext dev`; authenticated
local queries will fail until its schema exists. Treat the first functional D1
acceptance check as a hosted, owner-only deployment check unless the Sites
starter documents a local migration workflow. The package's own Miniflare test
suite separately applies and verifies the same schema in workerd.

Identity-less probes of an owner-only Site need two independent credentials:
the temporary Sites bypass header and the endpoint's `Authorization` bearer.
`scripts/deployed-e2e.mjs` supports these as documented in
`docs/deployed-e2e.md`.

## Acceptance checks

Record evidence for each item:

- The site builds without Node-only module initialization errors.
- An unauthenticated query receives HTTP 401.
- An authenticated `ASK {}` receives HTTP 200 and SPARQL Results JSON.
- Authenticated ASK and SELECT requests with
  `Accept: application/sparql-results+xml` receive HTTP 200 and well-formed,
  semantically correct SPARQL Results XML.
- A `SERVICE <https://example.invalid/>` query receives HTTP 403.
- A remote `LOAD <https://example.invalid/data.ttl>` update receives HTTP 403,
  including on the temporary writable validation route.
- D1 contains strict `rdf_quads` and `rdf_patch_guards` tables, the composite
  uniqueness autoindex, and three distinct cyclic covering indexes.
- The installed package's `npm run test:deployed:schema` command receives HTTP
  200 from the temporary schema route and verifies `STRICT` plus the exact
  names and column order of all four effective indexes.
- If testing the authenticated admin route, a named-graph insert is visible to
  a later SELECT and can be removed. Configure its distinct
  `SPARQL_ADMIN_TOKEN`, then remove the route after validation unless the site
  requires an owner-only administrative endpoint.

Mount `app/api/sparql/schema/route.ts` beside the temporary admin
route and protect both with the distinct `SPARQL_ADMIN_TOKEN`. After deployment,
run the catalog verifier from the installed package:

```sh
SPARQL_SCHEMA_ENDPOINT=https://example.test/api/sparql/schema \
SPARQL_AUTH_HEADER=Authorization \
SPARQL_AUTH_TOKEN="$SPARQL_ADMIN_TOKEN" \
SPARQL_OUTER_AUTH_HEADER=OAI-Sites-Authorization \
SPARQL_OUTER_AUTH_TOKEN="$SITES_TEST_BYPASS_TOKEN" \
npm explore @gnolith/diamond -- npm run test:deployed:schema
```

The command must report both tables as strict, the uniqueness autoindex plus
three exact named indexes, and `valid: true`. Remove the schema route together
with the writable route and administrator secret before the final deployment.

For a temporary write-enabled validation endpoint, run the repository's
`scripts/deployed-e2e.mjs` through `npm run test:deployed`, as documented
in `docs/deployed-e2e.md`. Run it from the installed package (for example with
`npm explore @gnolith/diamond -- npm run test:deployed`) to prove the published
artifact contains the script.

## Sign-off record

- Validator and type (person / independent agent):
- Date:
- Package commit:
- Package SHA-256:
- Sites starter/version:
- Deployment URL or evidence location:
- Corrections made:
- Result: pass / fail
