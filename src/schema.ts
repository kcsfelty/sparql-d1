import type { D1DatabaseLike } from './d1-types.js';
import {
  MigrationStateError,
  applyNamespacedMigrations,
  ensureMigrationLedger,
  readAppliedMigrations,
  recordMigrationAdoption,
  type NamespacedMigration,
} from './migrations.js';

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

export const diamondMigrationNamespace = '@gnolith/diamond' as const;

export const diamondMigrations: readonly NamespacedMigration[] = [
  {
    id: '0001-current-rdf-schema',
    statements: schemaStatements,
  },
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

const expectedStoreIndexSql: Record<
  keyof typeof expectedStoreIndexes,
  string | null
> = {
  sqlite_autoindex_rdf_quads_1: null,
  rdf_quads_pogs_idx: schemaStatements[2],
  rdf_quads_ogsp_idx: schemaStatements[3],
  rdf_quads_gspo_idx: schemaStatements[4],
};

const expectedQuadColumns = [
  ['id', 'INTEGER', 0, 1],
  ['subject_key', 'TEXT', 1, 0],
  ['subject_json', 'TEXT', 1, 0],
  ['predicate_key', 'TEXT', 1, 0],
  ['predicate_json', 'TEXT', 1, 0],
  ['object_key', 'TEXT', 1, 0],
  ['object_json', 'TEXT', 1, 0],
  ['graph_key', 'TEXT', 1, 0],
  ['graph_json', 'TEXT', 1, 0],
] as const;

const expectedGuardColumns = [['patch_id', 'TEXT', 1, 1]] as const;

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface IndexCatalogRow {
  tbl_name: string;
  sql: string | null;
}

const diamondTableNames = new Set(['rdf_quads', 'rdf_patch_guards']);
const allowedDiamondIndexes = new Set([
  ...Object.keys(expectedStoreIndexes),
  'sqlite_autoindex_rdf_patch_guards_1',
]);

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
  await migrateDiamondStore(db);
}

/** Apply or conservatively adopt Diamond's schema and migration history. */
export async function migrateDiamondStore(db: D1DatabaseLike): Promise<void> {
  await ensureMigrationLedger(db);
  const applied = await readAppliedMigrations(db, diamondMigrationNamespace);
  if (applied.length > 0) {
    await applyNamespacedMigrations(
      db,
      diamondMigrationNamespace,
      diamondMigrations,
    );
    return;
  }

  const associatedObjects = await readAssociatedSchemaObjects(db);
  if (associatedObjects.length === 0) {
    await applyNamespacedMigrations(
      db,
      diamondMigrationNamespace,
      diamondMigrations,
    );
    return;
  }

  const inspection = await inspectStoreSchema(db);
  if (!inspection.valid) {
    throw new MigrationStateError(
      `Existing Diamond schema is partial or ambiguous and was not modified: ${inspection.errors.join('; ')}`,
    );
  }
  await recordMigrationAdoption(
    db,
    diamondMigrationNamespace,
    diamondMigrations[0]!,
  );
  await applyNamespacedMigrations(
    db,
    diamondMigrationNamespace,
    diamondMigrations,
  );
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

  if (tableSql) {
    await inspectColumns(db, 'rdf_quads', expectedQuadColumns, errors);
  }
  if (guardTableSql) {
    await inspectColumns(db, 'rdf_patch_guards', expectedGuardColumns, errors);
  }

  const associatedObjects = await readAssociatedSchemaObjects(db);
  for (const object of associatedObjects) {
    if (object.type === 'table' && !diamondTableNames.has(object.name)) {
      errors.push(`unexpected Diamond-like table ${object.name}`);
    } else if (
      object.type === 'index' &&
      !allowedDiamondIndexes.has(object.name)
    ) {
      errors.push(`unexpected index ${object.name} affects ${object.tbl_name}`);
    } else if (object.type === 'trigger') {
      errors.push(`unexpected trigger ${object.name} affects Diamond storage`);
    } else if (object.type === 'view') {
      errors.push(`unexpected view ${object.name} targets Diamond storage`);
    }
  }

  for (const [indexName, expectedColumns] of Object.entries(
    expectedStoreIndexes,
  )) {
    const catalogResult = await db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_schema
         WHERE type = 'index' AND name = ?`,
      )
      .bind(indexName)
      .all<IndexCatalogRow>();
    const catalog = catalogResult.results[0];
    if (!catalog) {
      errors.push(`${indexName} is missing from the index catalog`);
    } else {
      if (catalog.tbl_name !== 'rdf_quads') {
        errors.push(
          `${indexName} belongs to ${catalog.tbl_name}, expected rdf_quads`,
        );
      }
      const expectedSql =
        expectedStoreIndexSql[indexName as keyof typeof expectedStoreIndexes];
      if (!matchesExpectedIndexSql(catalog.sql, expectedSql)) {
        errors.push(`${indexName} has an unexpected index definition`);
      }
    }
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

async function inspectColumns(
  db: D1DatabaseLike,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
  errors: string[],
): Promise<void> {
  const result = await db
    .prepare(`PRAGMA table_info("${table}")`)
    .all<TableInfoRow>();
  const actual = result.results.map(
    (column) =>
      [
        column.name,
        column.type.toUpperCase(),
        column.notnull,
        column.pk,
      ] as const,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${table} has an unexpected column definition`);
  }
}

async function readAssociatedSchemaObjects(
  db: D1DatabaseLike,
): Promise<SchemaObjectRow[]> {
  const result = await db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all<SchemaObjectRow>();
  return result.results.filter(isDiamondAssociatedObject);
}

function isDiamondAssociatedObject(object: SchemaObjectRow): boolean {
  if (object.name.startsWith('rdf_')) {
    return true;
  }
  if (
    (object.type === 'index' || object.type === 'trigger') &&
    diamondTableNames.has(object.tbl_name)
  ) {
    return true;
  }
  if (object.type === 'trigger' || object.type === 'view') {
    return referencesDiamondTable(object.sql);
  }
  return false;
}

function referencesDiamondTable(sql: string | null): boolean {
  return (
    sql !== null &&
    /(?:^|[^a-z0-9_])rdf_(?:quads|patch_guards)(?:$|[^a-z0-9_])/iu.test(sql)
  );
}

function matchesExpectedIndexSql(
  actual: string | null,
  expected: string | null,
): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (actual === null) {
    return false;
  }
  const withoutConditional = expected.replace(
    'CREATE INDEX IF NOT EXISTS',
    'CREATE INDEX',
  );
  return (
    normalizeSchemaSql(actual) === normalizeSchemaSql(expected) ||
    normalizeSchemaSql(actual) === normalizeSchemaSql(withoutConditional)
  );
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toLowerCase();
}
