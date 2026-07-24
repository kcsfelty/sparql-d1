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

`validateDiamondBackupSectionV1(section)` validates the section envelope,
canonical payload, payload SHA-256, and exact Diamond migration-ledger evidence.
It accepts no database capability, performs no I/O, and returns immutable counts
and digest metadata. Use it to verify an archive while the live installation is
populated. `dryRunImport` instead checks restore readiness and therefore requires
a separate target that satisfies the selected empty-domain rule.
Archive codecs must round-trip `payload` as a `Uint8Array` (for example through
a canonical base64 byte node); ordinary `JSON.stringify` alone does not preserve
typed bytes. Validation failures use `DiamondBackupValidationError`, with the
bounded `reason` and `details.backupReason` codes declared by
`DiamondBackupValidationReason`. They never disclose payload, installation,
table, or target-database values.

`decodeDiamond041LegacyOwnerV1({source, attestation, limits})` accepts the
read-only `SqlReadDatabase` capability and only the exact package/version
attestation `{packageName: '@gnolith/diamond', packageVersion: '0.4.1'}`. It
queries fixed Diamond-owned tables, indexes, and the Diamond ledger namespace;
it performs no writes and has hard row/byte ceilings. The resulting frozen
`DiamondLegacyOwnerFragment` exposes counts, SHA-256 digests, and canonical
namespace evidence while keeping owner payload bytes in a private in-memory
brand.

`adoptDiamond041LegacyOwnerV1(fragment)` rejects forged or serialized fragments
and returns a `DiamondBackupSection` accepted by the normal dry-run/import flow.
Diamond exposes no migration or backup CLI.

## `@gnolith/diamond/node-sqlite`

`NodeSqliteDatabase` is an optional Node 22+ adapter. Its batch is ordered,
connection-bound, and transactional with rollback on any statement or commit
failure. It declares bigint and `first()` capabilities explicitly.
