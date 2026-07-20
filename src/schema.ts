import type { D1DatabaseLike } from './d1-types.js';

export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS rdf_quads (
    id INTEGER PRIMARY KEY,
    subject_key TEXT NOT NULL,
    subject_json TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    predicate_json TEXT NOT NULL,
    object_key TEXT NOT NULL,
    object_json TEXT NOT NULL,
    graph_key TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    UNIQUE(subject_key, predicate_key, object_key, graph_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS rdf_patch_guards (
    patch_id TEXT PRIMARY KEY
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS rdf_quads_pogs_idx
    ON rdf_quads(predicate_key, object_key, graph_key, subject_key)`,
  `CREATE INDEX IF NOT EXISTS rdf_quads_ogsp_idx
    ON rdf_quads(object_key, graph_key, subject_key, predicate_key)`,
  `CREATE INDEX IF NOT EXISTS rdf_quads_gspo_idx
    ON rdf_quads(graph_key, subject_key, predicate_key, object_key)`,
  `DROP INDEX IF EXISTS rdf_quads_spog_idx`,
] as const;

export const expectedStoreIndexes = {
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
} as const;

export interface StoreSchemaInspection {
  table: {
    name: 'rdf_quads';
    sql: string | null;
    strict: boolean;
  };
  guardTable: {
    name: 'rdf_patch_guards';
    sql: string | null;
    strict: boolean;
  };
  indexes: Record<string, string[]>;
  valid: boolean;
  errors: string[];
}

export async function initializeStore(db: D1DatabaseLike): Promise<void> {
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
}

export async function inspectStoreSchema(
  db: D1DatabaseLike,
): Promise<StoreSchemaInspection> {
  const tableResult = await db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .bind('rdf_quads')
    .all<{ sql: string | null }>();
  const tableSql = tableResult.results[0]?.sql ?? null;
  const strict = tableSql !== null && /\)\s*STRICT\s*$/iu.test(tableSql);
  const guardTableResult = await db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .bind('rdf_patch_guards')
    .all<{ sql: string | null }>();
  const guardTableSql = guardTableResult.results[0]?.sql ?? null;
  const guardTableStrict =
    guardTableSql !== null && /\)\s*STRICT\s*$/iu.test(guardTableSql);
  const indexes: Record<string, string[]> = {};
  const errors: string[] = [];

  if (!tableSql) {
    errors.push('rdf_quads table is missing');
  } else if (!strict) {
    errors.push('rdf_quads table is not STRICT');
  }
  if (!guardTableSql) {
    errors.push('rdf_patch_guards table is missing');
  } else if (!guardTableStrict) {
    errors.push('rdf_patch_guards table is not STRICT');
  }

  for (const [indexName, expectedColumns] of Object.entries(
    expectedStoreIndexes,
  )) {
    const result = await db
      .prepare(`PRAGMA index_info("${indexName}")`)
      .all<{ name: string; seqno: number }>();
    const columns = [...result.results]
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    indexes[indexName] = columns;
    if (
      columns.length !== expectedColumns.length ||
      columns.some((column, position) => column !== expectedColumns[position])
    ) {
      errors.push(
        `${indexName} has columns [${columns.join(', ')}], expected [${expectedColumns.join(', ')}]`,
      );
    }
  }

  return {
    table: { name: 'rdf_quads', sql: tableSql, strict },
    guardTable: {
      name: 'rdf_patch_guards',
      sql: guardTableSql,
      strict: guardTableStrict,
    },
    indexes,
    valid: errors.length === 0,
    errors,
  };
}
