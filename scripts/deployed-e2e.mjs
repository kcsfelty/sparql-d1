import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const endpoint = process.env.SPARQL_ENDPOINT;

if (!endpoint) {
  throw new Error('SPARQL_ENDPOINT must be the complete deployed endpoint URL');
}

const authHeader = process.env.SPARQL_AUTH_HEADER;
const authToken = process.env.SPARQL_AUTH_TOKEN;
const outerAuthHeader = process.env.SPARQL_OUTER_AUTH_HEADER;
const outerAuthToken = process.env.SPARQL_OUTER_AUTH_TOKEN;

if (Boolean(authHeader) !== Boolean(authToken)) {
  throw new Error(
    'SPARQL_AUTH_HEADER and SPARQL_AUTH_TOKEN must be set together',
  );
}
if (Boolean(outerAuthHeader) !== Boolean(outerAuthToken)) {
  throw new Error(
    'SPARQL_OUTER_AUTH_HEADER and SPARQL_OUTER_AUTH_TOKEN must be set together',
  );
}

const authorization =
  authHeader && authToken ? { [authHeader]: `Bearer ${authToken}` } : {};
const outerAuthorization =
  outerAuthHeader && outerAuthToken
    ? { [outerAuthHeader]: `Bearer ${outerAuthToken}` }
    : {};
const authentication = { ...outerAuthorization, ...authorization };
const id = randomUUID();
const graph = `https://example.test/deployed-e2e/${id}`;
const subject = `${graph}#subject`;
const predicate = 'https://example.test/value';
const value = `deployed-${id}`;

async function request(query, accept) {
  const url = new URL(endpoint);
  url.searchParams.set('query', query);
  return fetch(url, {
    headers: { ...authentication, ...(accept ? { accept } : {}) },
  });
}

async function update(operation) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      ...authentication,
      'content-type': 'application/sparql-update',
    },
    body: operation,
  });
}

async function assertStatus(response, expected) {
  if (response.status !== expected) {
    assert.fail(
      `Expected HTTP ${expected}, received ${response.status}: ${await response.text()}`,
    );
  }
}

let inserted = false;

try {
  const insert = await update(`
    INSERT DATA {
      GRAPH <${graph}> {
        <${subject}> <${predicate}> "${value}"@en
      }
    }
  `);
  await assertStatus(insert, 204);
  inserted = true;

  const select = await request(
    `SELECT ?value ?graph WHERE {
       GRAPH ?graph { <${subject}> <${predicate}> ?value }
     }`,
    'application/sparql-results+json',
  );
  await assertStatus(select, 200);
  const results = await select.json();
  assert.equal(results.results.bindings.length, 1);
  assert.equal(results.results.bindings[0].value.value, value);
  assert.equal(results.results.bindings[0].value['xml:lang'], 'en');
  assert.equal(results.results.bindings[0].graph.value, graph);

  const xml = await request('ASK {}', 'application/sparql-results+xml');
  await assertStatus(xml, 200);
  assert.match(
    xml.headers.get('content-type') ?? '',
    /^application\/sparql-results\+xml/u,
  );
  assert.match(await xml.text(), /<boolean>true<\/boolean>/u);

  const construct = await request(
    `CONSTRUCT { <${subject}> <${predicate}> ?value }
     WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?value } }`,
    'application/n-triples',
  );
  await assertStatus(construct, 200);
  assert.match(await construct.text(), new RegExp(`"${value}"@en`));

  const service = await request(
    'SELECT * WHERE { SERVICE <https://example.invalid/sparql> { ?s ?p ?o } }',
    'application/sparql-results+json',
  );
  await assertStatus(service, 403);

  console.log(
    JSON.stringify({
      endpoint,
      insertStatus: insert.status,
      selectStatus: select.status,
      xmlStatus: xml.status,
      constructStatus: construct.status,
      serviceStatus: service.status,
      bindingCount: results.results.bindings.length,
    }),
  );
} finally {
  if (inserted) {
    const cleanup = await update(`DROP SILENT GRAPH <${graph}>`);
    await assertStatus(cleanup, 204);
  }
}
