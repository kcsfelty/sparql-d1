import assert from 'node:assert/strict';

const endpoint = process.env.SPARQL_SCHEMA_ENDPOINT;
if (!endpoint) {
  throw new Error(
    'SPARQL_SCHEMA_ENDPOINT must be the complete deployed schema endpoint URL',
  );
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

const headers = {
  ...(outerAuthHeader && outerAuthToken
    ? { [outerAuthHeader]: `Bearer ${outerAuthToken}` }
    : {}),
  ...(authHeader && authToken ? { [authHeader]: `Bearer ${authToken}` } : {}),
};
const response = await fetch(endpoint, { headers });
assert.equal(response.status, 200, await response.clone().text());
assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);

const inspection = await response.json();
const expectedIndexes = {
  sqlite_autoindex_rdf_quads_1: [
    'subject_key',
    'predicate_key',
    'object_key',
    'graph_key',
  ],
  rdf_quads_pogs_idx: [
    'predicate_key',
    'object_key',
    'graph_key',
    'subject_key',
  ],
  rdf_quads_ogsp_idx: [
    'object_key',
    'graph_key',
    'subject_key',
    'predicate_key',
  ],
  rdf_quads_gspo_idx: [
    'graph_key',
    'subject_key',
    'predicate_key',
    'object_key',
  ],
};

assert.equal(inspection.valid, true);
assert.deepEqual(inspection.errors, []);
assert.equal(inspection.table?.name, 'rdf_quads');
assert.equal(inspection.table?.strict, true);
assert.match(inspection.table?.sql ?? '', /\)\s*STRICT\s*$/iu);
assert.equal(inspection.guardTable?.name, 'rdf_patch_guards');
assert.equal(inspection.guardTable?.strict, true);
assert.match(inspection.guardTable?.sql ?? '', /\)\s*STRICT\s*$/iu);
assert.deepEqual(inspection.indexes, expectedIndexes);

console.log(
  JSON.stringify({
    endpoint,
    status: response.status,
    table: inspection.table.name,
    strict: inspection.table.strict,
    guardTable: inspection.guardTable.name,
    indexes: Object.keys(inspection.indexes),
    valid: inspection.valid,
  }),
);
