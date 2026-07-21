# Embedded SQLite and migrations

Diamond's minimum storage capability is SQLite-shaped and asynchronous:
`prepare`, statement `bind`/`run`/`all`, and ordered atomic `batch`. The
runtime-neutral names are `SqliteDatabaseLike`, `SqlitePreparedStatementLike`,
and `SqliteResultLike`. The existing `D1*Like` declarations remain unchanged
and structurally compatible. `first()` is not part of the minimum; adapters may
separately implement `SqliteFirstCapability`.

## Node adapter

`@gnolith/diamond/node-sqlite` exports `NodeSqliteDatabase`, an embedded,
process-local adapter built on `node:sqlite`. It is not a database server or a
remote protocol. The subpath supports Node.js 22.16 or newer on the Node 22
line, Node 23.11 or newer on the Node 23 line, and Node 24 or newer. It is
isolated from Diamond's root and Worker entry points.

```ts
import { initializeStore } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';

const db = new NodeSqliteDatabase('./data/gnolith.sqlite');
await initializeStore(db);
await db.close();
```

Pass `:memory:` for an ephemeral connection. File databases enable foreign
keys, use a 5-second busy timeout by default, and request WAL journal mode.
Override the bounded lock wait with `{ busyTimeoutMs }`. Memory databases do
not request WAL. The adapter does not silently retry busy or constraint
failures.

Each connection serializes operations with a FIFO mutex. `batch()` validates
that every statement belongs to that adapter, runs statements in input order
inside `BEGIN IMMEDIATE`, and rolls back on any statement or commit failure.
Statements from another connection and operations after `close()` are rejected.
Call `close()` (or use async disposal) before replacing or deleting a file.
Multiple processes may open the same WAL database, but SQLite locking and the
configured busy timeout still apply; this adapter does not provide distributed
coordination.

## Portable conditional writes and BLOB rows

Diamond's shared adapter conformance suite submits conditional writes
concurrently through multiple Node SQLite connections to one persisted WAL
file and through a real workerd D1 binding. It proves that callers can use
`all()` with a conditional
`UPDATE ... RETURNING` statement to implement an optimistic claim: competing
attempts for one expected revision yield exactly one returned row and one
change, while a later stale-revision attempt yields no rows and zero changes.
This proves observable conditional semantics, not that the test forces a
particular physical lock overlap or scheduling order. Separate child-process
coverage exercises native lock contention and the bounded busy timeout. The
database still owns serialization; Diamond does not add retries, queue policy,
leasing, ranking, or authorization semantics.

Scalar bindings (`string`, integral and real `number`, and `null`) round-trip
with the same row values in both runtimes. BLOB row representations differ:
Node's built-in driver returns `Uint8Array`, while workerd D1 returns a
JSON-compatible number array. Use `readSqliteBytes(value)` from
`@gnolith/diamond` to obtain a detached `Uint8Array` in portable code. It also
accepts `ArrayBuffer` and other array-buffer views and rejects malformed byte
arrays rather than coercing them.

These are low-level SQL capabilities, not a search contract. The package that
owns a domain table remains responsible for its schema, claim conditions,
revision meaning, authorization, indexing, and recovery behavior.

## Migration ledger

The `_gnolith_migrations` STRICT table records a package namespace, stable
migration ID, SHA-256 content checksum, adoption marker, and application time.
`applyNamespacedMigrations()` owns only the supplied namespace. The ledger must
match Diamond's exact STRICT schema, including its primary key, default, and
CHECK constraint. The migrator rejects
unknown/newer IDs, gaps, reordered history, checksum drift, and an incompatible
ledger schema. Migration statements and their successful ledger insert share
one adapter batch.

Each package owns its namespace, migration definitions, and any legacy-schema
inspection. `recordMigrationAdoption()` only records a baseline after the
owning package has verified the existing schema exactly. Seedbed or another
host may invoke package migrators in dependency order, but does not own their
schemas. Diamond must migrate before packages whose tables reference or compose
with the RDF store.

`initializeStore()` remains the compatible Diamond entry point. On an empty
database it creates the ledger and current RDF schema. On an exact pre-ledger
Diamond store it records an adopted baseline without replaying DDL or rewriting
quads. Exact adoption also rejects every unexpected index, trigger, or view
that targets or references Diamond tables, regardless of the object's name.
Partial, ambiguous, unexpected, or drifted Diamond states are rejected
with `MigrationStateError` rather than repaired destructively.

D1 and the Node adapter both promise atomic ordered batches. A concurrent
initializer that loses a ledger-insert race re-reads and accepts the winner
only when the checksum matches. D1 exposes no connection-level transaction API
beyond `batch()`, so callers should treat other busy/concurrent initialization
failures as retryable startup failures; Diamond does not claim a broader lock.
