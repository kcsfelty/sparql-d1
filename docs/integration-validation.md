# Independent Codex Sites integration validation

This checklist is intentionally executable by someone who did not author the
package. Record the tester, date, package commit, Sites starter version, and
any documentation corrections in the pull request or issue used for sign-off.

## Prepare the private artifact

From a clean clone of this repository:

```sh
npm ci
npm run check
npm pack
```

The last command creates `sparql-d1-0.0.0.tgz` for the current private
pre-release. Copy that archive into a `vendor/` directory in a new Codex Sites
project and install it:

```sh
npm install ./vendor/sparql-d1-0.0.0.tgz
```

Do not use `npm install sparql-d1` until the package has actually been
published. Do not install the Git repository directly; generated `dist` files
are deliberately not committed.

## Add the endpoint

Copy these paths from `examples/codex-site`, preserving their relative paths:

- `.openai/hosting.json`
- `app/api/sparql/route.ts`
- `drizzle/0000_rdf_quads.sql`

Set the secret runtime value `SPARQL_TOKEN`. Keep the site owner-only during
validation, then build and deploy through the normal Codex Sites workflow.

## Acceptance checks

Record evidence for each item:

- The site builds without Node-only module initialization errors.
- An unauthenticated query receives HTTP 401.
- An authenticated `ASK {}` receives HTTP 200 and SPARQL Results JSON.
- A `SERVICE <https://example.invalid/>` query receives HTTP 403.
- D1 contains the strict `rdf_quads` table and four covering indexes.
- If testing an authenticated update route, a named-graph insert is visible to
  a later SELECT and can be removed. Keep the public example read-only.

For a temporary write-enabled validation endpoint, run the repository's
`scripts/deployed-e2e.mjs` as documented in `docs/deployed-e2e.md`.

## Sign-off record

- Tester:
- Date:
- Package commit:
- Sites starter/version:
- Deployment URL or evidence location:
- Corrections made:
- Result: pass / fail
