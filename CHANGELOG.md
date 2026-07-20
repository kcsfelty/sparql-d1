# Changelog

All notable changes will be documented here. Versions follow Semantic
Versioning after the first public release.

## [Unreleased]

## [0.3.0] - 2026-07-20

### Changed

- Renamed the project to Diamond and moved the source repository to the
  Gnolith organization.
- Published the package under its permanent scoped identity,
  `@gnolith/diamond`; the former `sparql-d1` package now points users here.

## [0.2.1] - 2026-07-20

### Added

- Atomic forbidden-quad absence assertions for guarded creation workflows.
- Recursive RDF quad-position validation across every exact write path.
- Complete add/delete statement commands and identity invariants in the
  Wikibase-style application example.

### Fixed

- Prevented RDF Store imports/removals from writing after their input stream
  reports an error.
- Enforced POST size limits while streaming the complete encoded body.
- Applied one absolute timeout across body reading, parsing, engine acquisition,
  query work, and serialization.
- Evaluated require-only quad-patch assertions instead of returning early.
- Excluded deprecated-only statements from best-rank/truthy projections and
  hardened entity/statement/reference lifecycle behavior.

## [0.2.0] - 2026-07-20

### Added

- Atomic `applyQuadPatch()` delete/insert transactions with optimistic required
  quads and workerd concurrency/rollback coverage.
- Opt-in keyset pagination through `pageSize` and `sourcePageSize`, including
  cancellation, observation, all-pattern, workerd, and benchmark evidence.
- An executable Codex Sites Wikibase-style statement application example.
- A reproducible RDF storage-layout benchmark and documented SQL-pushdown
  boundary decision.

### Changed

- Removed the redundant explicit SPOG index in favor of the identical UNIQUE
  autoindex, with a versioned migration and schema-inspection update.
- Updated installation and integration documentation for the public npm package.

## [0.1.0] - 2026-07-19

### Added

- D1-backed RDF/JS Source and Store baseline.
- Lossless term encoding including quoted triple terms.
- SPARQL Protocol endpoint with secure defaults and streaming serializers.
- Unit, generated, differential, protocol, update, and workerd D1 tests.
- Coverage, Worker bundle, package artifact, and benchmark gates.
- Request cancellation, host rate-limit integration, and exact per-target
  federation authorization.
- W3C conformance/EARL reporting and install-from-tarball consumer validation.
- Multi-shape workerd D1 and Comunica performance baselines.
- Deterministic release checks, SBOMs, checksums, artifact attestations, and
  public-repository-only npm provenance publishing.
- A clean-project Codex Sites integration checklist and packaged Drizzle
  migration example.
- Direct coverage of every advertised result format and standards-based HTTP
  media-range negotiation.
- Strict query/update protocol separation, including POST-only updates and
  rejection of ambiguous or disguised operations.
- Federation fetch reauthorization and redirect rejection to prevent allowed
  URLs from redirecting to unreviewed SSRF targets.
- A source-factory extension boundary for future SQL-pushdown implementations.
- Default rejection of remote SPARQL `LOAD`, including on writable endpoints.
- Explicit experimental-release and sole-maintainer governance policies.
- Worker-safe SPARQL Results XML serialization for ASK and SELECT, guarded by
  a bundled-workerd regression test.
- An artifact-contained deployed probe supporting separate outer Sites and
  endpoint bearer credentials.
- A fail-closed managed-D1 schema validation route and packed verifier for the
  STRICT table and exact covering-index catalog layout.
