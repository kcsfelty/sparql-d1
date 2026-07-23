# API

## Root storage entry

`SqlValue`, `SqlStatement`, `SqlDatabase`, and `SqlResult` are readonly,
runtime-neutral structural contracts. `readSqlCapabilities()` returns a
declared capability descriptor or `null`; callers never discover native/D1
differences by intentionally failing a write.

`D1QuadSource` and `D1QuadStore` preserve RDF/JS Source and Store semantics,
named graphs, term fidelity, deterministic pagination, and bounded atomic
writes. `prepareQuadPatch()` returns an opaque connection-bound plan.
`statementsForQuadPatch(db, plan)` is required when composing that plan with
owner SQL in one ordered atomic batch.

`applyNamespacedMigrations()` owns only its namespace and rejects checksum
drift, unknown/newer rows, gaps, duplicates, malformed ledgers, and partial
adoption.

`createMigrationAssemblyAuthorityV1(db, installationId)` creates an opaque
assembly token. `registerMigrationLedgerOwnerV1()` binds a namespace and ordered
manifest to that token, installation, and exact connection. The frozen
`MigrationLedgerOwnerHandle` has no public constructor and is invalid after
serialization.

`createMigrationLedgerBackupV1()` exports and validates
`diamond-migration-ledger-slice-v1` evidence and restores only its registered
namespace in `empty` or explicitly confirmed `exact-adopt` mode. The digest is
SHA-256 over JCS of the complete slice with `canonicalSha256` omitted.

## `@gnolith/diamond/sparql`

`createSparqlExecutor(options)` returns:

```ts
(request: {
  operation: 'query' | 'update';
  text: string;
  accept?: string;
  signal?: AbortSignal;
}) =>
  Promise<{
    status: number;
    mediaType?: string;
    body?: ReadableStream<Uint8Array>;
  }>;
```

`policy` configures read-only mode, byte/algebra/deadline bounds, and optional
per-target SERVICE authorization/fetch. It contains no transport request,
headers, route, identity, CORS, authentication, or rate-limit policy.

## `@gnolith/diamond/backup`

`createDiamondBackupV1({db, owner, ledgerBackup})` returns `inspect`, `export`,
`dryRunImport`, and `import`. `DiamondBackupSection` contains owner/format/schema
versions, the Diamond ledger slice, an opaque `Uint8Array` payload, and SHA-256.
Imports require an empty target or exact migration-bound target. Foreign objects
are not enumerated for export and are never modified.

## `@gnolith/diamond/node-sqlite`

`NodeSqliteDatabase` is an optional Node 22+ adapter. Its batch is ordered,
connection-bound, and transactional with rollback on any statement or commit
failure. It declares bigint and `first()` capabilities explicitly.
