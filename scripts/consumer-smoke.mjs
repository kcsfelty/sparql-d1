import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';

const require = createRequire(import.meta.url);

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('consumer smoke must be run through npm');
}
const root = mkdtempSync(join(tmpdir(), 'diamond-consumer-'));
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'));
const packagePath = join(...sourcePackage.name.split('/'));
const packOutput = execFileSync(
  process.execPath,
  [npmCli, 'pack', '--json', '--pack-destination', root],
  { encoding: 'utf8' },
);
const [{ filename }] = JSON.parse(packOutput);
const archive = join(root, filename);

writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
execFileSync(
  process.execPath,
  [
    npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    root,
    archive,
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import {
      D1QuadSource,
      MAX_PORTABLE_SQLITE_BIND_BYTES,
      allowServiceUrls,
      assertSqlitePayloadSize,
      initializeStore,
      prepareQuadPatch,
      readSqliteBytes,
    } from '@gnolith/diamond';
    import { createSparqlHandler } from '@gnolith/diamond/endpoint';
    import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
    import { DataFactory } from 'rdf-data-factory';
    if (
      typeof D1QuadSource !== 'function' ||
      typeof allowServiceUrls !== 'function' ||
      typeof initializeStore !== 'function' ||
      typeof createSparqlHandler !== 'function'
    ) {
      throw new Error('Expected package exports are unavailable');
    }
    const path = ${JSON.stringify(join(root, 'packed-consumer.sqlite'))};
    const db = new NodeSqliteDatabase(path);
    await initializeStore(db);
    await db.prepare(
      'CREATE TABLE consumer_probe (value TEXT NOT NULL, bytes BLOB NOT NULL, revision INTEGER NOT NULL)'
    ).run();
    const factory = new DataFactory();
    const quad = factory.quad(
      factory.namedNode('https://example.test/packed-subject'),
      factory.namedNode('https://example.test/packed-predicate'),
      factory.literal('packed-object'),
    );
    const prepared = prepareQuadPatch(db, { insert: [quad] });
    const bytes = Uint8Array.from([0, 127, 255]);
    if (assertSqlitePayloadSize(['durable', bytes]) >= MAX_PORTABLE_SQLITE_BIND_BYTES) {
      throw new Error('Packed portable payload-bound helper returned an invalid size');
    }
    const results = await db.batch([
      db.prepare('INSERT INTO consumer_probe VALUES (?, ?, ?)')
        .bind('durable', bytes, 9007199254740993n),
      ...prepared.statements,
    ]);
    if (prepared.readResult(results, 1).inserted !== 1) {
      throw new Error('Packed prepared-patch result mapping failed');
    }
    await db.close();
    const reopened = new NodeSqliteDatabase(path);
    const probe = await reopened.prepare(
      'SELECT value, bytes, revision FROM consumer_probe'
    ).first();
    if (
      probe?.value !== 'durable' ||
      probe.revision !== 9007199254740993n ||
      readSqliteBytes(probe.bytes).join(',') !== '0,127,255'
    ) {
      throw new Error('Packed node:sqlite subpath did not persist data');
    }
    if (await new D1QuadSource(reopened).countQuads(quad.subject) !== 1) {
      throw new Error('Packed prepared RDF patch did not persist atomically');
    }
    await reopened.close();
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

const installed = JSON.parse(
  readFileSync(join(root, 'node_modules', packagePath, 'package.json'), 'utf8'),
);
const nodeAdapterTypes = readFileSync(
  join(root, 'node_modules', packagePath, 'dist', 'node-sqlite.d.ts'),
  'utf8',
);
assert.doesNotMatch(
  nodeAdapterTypes,
  /readonly connection|\bexecute</u,
  'Node adapter declarations expose connection or mutex-bypass internals',
);
if (
  installed.private !== sourcePackage.private ||
  installed.version !== sourcePackage.version
) {
  throw new Error('Packed metadata differs from the source package');
}

const workerPath = join(root, 'worker.mjs');
const wranglerPath = join(root, 'wrangler.jsonc');
const wranglerOutputPath = join(process.cwd(), '.wrangler');
mkdirSync(wranglerOutputPath, { recursive: true });
const bundlePath = mkdtempSync(join(wranglerOutputPath, 'exact-package-'));
writeFileSync(
  workerPath,
  `
    import { initializeStore } from '@gnolith/diamond';
    import { createSparqlHandler } from '@gnolith/diamond/endpoint';

    export default {
      async fetch(request, env) {
        await initializeStore(env.DB);
        return createSparqlHandler({ db: env.DB, readOnly: false })(request);
      },
    };
  `,
);
writeFileSync(
  wranglerPath,
  JSON.stringify({
    name: 'diamond-exact-package-check',
    main: 'worker.mjs',
    compatibility_date: '2026-07-19',
    compatibility_flags: ['nodejs_compat'],
  }),
);
const wranglerPackage = require.resolve('wrangler/package.json');
execFileSync(
  process.execPath,
  [
    join(dirname(wranglerPackage), 'bin', 'wrangler.js'),
    'deploy',
    '--dry-run',
    '--config',
    wranglerPath,
    '--outdir',
    bundlePath,
  ],
  { cwd: root, stdio: 'inherit' },
);

const bundledWorker = readdirSync(bundlePath).find((file) =>
  file.endsWith('.js'),
);
assert.ok(bundledWorker, 'Wrangler did not emit a Worker module');
const bundledWorkerPath = join(bundlePath, bundledWorker);
assert.doesNotMatch(
  readFileSync(bundledWorkerPath, 'utf8'),
  /node:sqlite/u,
  'Node SQLite adapter leaked into the Worker bundle',
);
const miniflare = new Miniflare({
  modules: true,
  scriptPath: bundledWorkerPath,
  compatibilityDate: '2026-07-19',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'diamond-exact-package-check' },
});
try {
  const emptyUrl = new URL('https://worker.test/api/sparql');
  emptyUrl.searchParams.set('query', 'ASK { ?s ?p ?o }');
  const emptyResponse = await miniflare.dispatchFetch(emptyUrl, {
    headers: { accept: 'application/sparql-results+json' },
  });
  assert.equal(emptyResponse.status, 200, await emptyResponse.clone().text());
  assert.deepEqual(await emptyResponse.json(), {
    head: {},
    boolean: false,
  });

  const insertResponse = await miniflare.dispatchFetch(
    'https://worker.test/api/sparql',
    {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: `INSERT DATA {
        <https://example.test/exact-package>
          <https://example.test/value>
          "sentinel"
      }`,
    },
  );
  assert.equal(insertResponse.status, 204, await insertResponse.clone().text());

  const populatedUrl = new URL('https://worker.test/api/sparql');
  populatedUrl.searchParams.set(
    'query',
    `ASK {
      <https://example.test/exact-package>
        <https://example.test/value>
        "sentinel"
    }`,
  );
  const populatedResponse = await miniflare.dispatchFetch(populatedUrl, {
    headers: { accept: 'application/sparql-results+json' },
  });
  assert.equal(
    populatedResponse.status,
    200,
    await populatedResponse.clone().text(),
  );
  assert.deepEqual(await populatedResponse.json(), {
    head: {},
    boolean: true,
  });
} finally {
  await miniflare.dispose();
  rmSync(bundlePath, { recursive: true, force: true });
}

console.log(
  `consumer and nodejs_compat Worker smoke passed for ${installed.name}@${installed.version}`,
);
