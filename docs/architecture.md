# Architecture

Diamond has four public graphs:

1. Root: runtime-neutral SQLite contracts, RDF/JS source/store, codec, payload
   bounds, migration ownership, and connection-bound patch plans.
2. `./sparql`: transport-neutral query/update execution and serializers.
3. `./backup`: owner-scoped Diamond inspection/export/import.
4. `./node-sqlite`: the only graph allowed to import `node:sqlite`.

Transport authorization belongs to the host. Diamond receives an already
authorized SPARQL operation and never receives a principal, route, header map,
or server object.

The migration ledger is shared but namespaced. An assembly authority binds each
owner's immutable ordered manifest to one installation and connection. Backups
use that opaque owner handle so a component cannot export, validate, adopt, or
restore another namespace.

RDF mutations are prepared as opaque plans. A private provenance registry binds
each plan to its preparing database; composition must pass through
`statementsForQuadPatch()`. Adapter batches then provide ordered atomic execution
and rollback.
