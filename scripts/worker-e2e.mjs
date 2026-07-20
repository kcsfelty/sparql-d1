import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { DataFactory } from 'rdf-data-factory';
import { initializeStore, insertQuads } from '../dist/index.js';

const miniflare = new Miniflare({
  modules: true,
  scriptPath: resolve('.wrangler/dry-run/worker.js'),
  compatibilityDate: '2026-07-19',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'sparql-d1-worker-test' },
});

try {
  const db = await miniflare.getD1Database('DB');
  await initializeStore(db);
  const factory = new DataFactory();
  await insertQuads(db, [
    factory.quad(
      factory.namedNode('https://example.test/worker'),
      factory.namedNode('https://example.test/value'),
      factory.literal('<&>"', 'en'),
    ),
  ]);

  async function query(sparql) {
    const url = new URL('https://worker.test/api/sparql');
    url.searchParams.set('query', sparql);
    return miniflare.dispatchFetch(url, {
      headers: { accept: 'application/sparql-results+xml' },
    });
  }

  const ask = await query('ASK {}');
  assert.equal(ask.status, 200, await ask.clone().text());
  assert.match(
    ask.headers.get('content-type') ?? '',
    /^application\/sparql-results\+xml/u,
  );
  assert.match(await ask.text(), /<head><\/head><boolean>true<\/boolean>/u);

  const select = await query(`
    SELECT ?value WHERE {
      <https://example.test/worker> <https://example.test/value> ?value
    }
  `);
  assert.equal(select.status, 200, await select.clone().text());
  const xml = await select.text();
  assert.match(xml, /<variable name="value"\/>/u);
  assert.match(xml, /<literal xml:lang="en">&lt;&amp;&gt;&quot;<\/literal>/u);
  assert.match(xml, /<\/sparql>$/u);

  console.log('bundled Worker XML ASK and SELECT checks passed');
} finally {
  await miniflare.dispose();
}
