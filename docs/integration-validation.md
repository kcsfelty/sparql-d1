# Published-package integration validation

This procedure validates Diamond's published package contract without assembling,
provisioning, deploying, or accepting a complete application site. Run it in a
fresh temporary project so success cannot depend on files from a source checkout.

## Published release

Create an empty ESM project with Node.js 22 or newer and install the public
package:

```sh
npm init -y
npm pkg set type=module
npm install @gnolith/diamond
```

Worker consumers must enable the `nodejs_compat` compatibility flag. This is a
published-package runtime prerequisite, not an application deployment check.

Import both public entry points and assert that the documented exports exist:

```js
import { D1QuadSource, initializeStore } from '@gnolith/diamond';
import { createSparqlHandler } from '@gnolith/diamond/endpoint';

if (
  typeof D1QuadSource !== 'function' ||
  typeof initializeStore !== 'function' ||
  typeof createSparqlHandler !== 'function'
) {
  throw new Error('Expected Diamond exports are unavailable');
}
```

## Unreleased artifact

For an unreleased commit, run the package checks and create the archive from the
source checkout:

```sh
npm ci
npm run check
npm pack
```

Record the archive SHA-256, then install that exact archive into a fresh temporary
project and repeat the public-entry import check. The repository's

```sh
npm run consumer:check
```

command automates the exact-package pack, install, and import smoke test. It
also bundles the installed public endpoint entry with `nodejs_compat`, verifies
an empty D1 result, inserts a sentinel through SPARQL Update, and reads it back
through the endpoint in Miniflare/workerd.

## Runtime contract checks

Diamond owns package-scoped checks that do not require application deployment:

- `npm run worker:bundle:check` bundles the maintained module-Worker fixture with
  Wrangler in dry-run mode.
- `npm run worker:local:test` executes that bundle against an ephemeral D1 binding
  in Miniflare/workerd.
- `npm test` covers the D1 contract, endpoint protocol, schema, source, storage,
  update, and security behavior locally.
- `npm run conformance` evaluates the applicable W3C SPARQL corpus.
- `npm run benchmark:check` and `npm run benchmark:storage:check` provide local,
  reproducible performance and storage evidence.

These checks establish package behavior in supported local runtimes. The agent
creating a complete site owns its hosting declaration, route assembly, secrets,
managed-resource provisioning, deployment, and hosted acceptance checks.

## Sign-off record

- Validator:
- Date:
- Package version or commit:
- Archive SHA-256, if applicable:
- Node and npm versions:
- Commands executed:
- Result: pass / fail
- Corrections or package defects found:
