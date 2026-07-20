# Architecture

## Request path

1. A Sites route receives a SPARQL Protocol GET or POST request.
2. The endpoint authenticates the request and enforces byte, algebra, update,
   federation, timeout, and result limits.
3. Comunica parses the query and calls the RDF/JS source with quad patterns.
4. `D1QuadSource` turns bound RDF terms into prepared SQL predicates.
5. D1 returns encoded rows, which the source reconstructs as RDF/JS quads.
6. Comunica evaluates higher-level algebra and serializes the result.

The D1 binding is injected by the host. The package never discovers databases,
stores Cloudflare credentials, or assumes a physical SQLite file.

## Storage

The baseline schema stores a canonical JSON encoding and equality key for each
quad position. This intentionally favors semantic transparency over maximum
storage density. Four cyclic covering indexes support subject-, predicate-,
object-, and graph-leading lookups.

The canonical representation preserves term type, lexical value, language,
datatype, default/named graph identity, blank-node label, and nested quoted
triple terms. The schema rejects duplicate quads.

## Update model

`D1QuadStore` implements the RDF/JS Store interface. Each insert or delete
stream is accumulated and committed through one atomic SQL statement backed by
SQLite JSON1. This avoids one D1 call per quad and prevents partial writes.
Schema migrations use D1's transactional `batch()` operation. Read-only mode
remains the endpoint default.

## Optimization boundary

The reference implementation exposes only `match()` and `countQuads()`.
Future implementations may group patterns or push joins, filters, ordering,
and limits into SQL. Every optimized path must be switchable and pass the same
differential suite as the reference source. Observable SPARQL multiset and
graph semantics are the compatibility boundary.
