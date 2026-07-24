# Changelog

All notable changes will be documented here. Versions follow Semantic
Versioning after the first public release.

## [Unreleased]

- Added database-free `validateDiamondBackupSectionV1` archive verification.
  Migration-bound restore now accepts independently initialized empty-domain
  targets with matching migration IDs/checksums while retaining mismatch and
  nonempty-target rejection.
- Added bounded `DiamondBackupValidationError` reason codes and packed
  JSON/archive round-trip coverage through validation and exact fresh-target
  restore.

## [0.5.0] - 2026-07-23

### Added

- Added a read-only, bounded decoder for exact
  `@gnolith/diamond@0.4.1` owner state. It inspects only fixed Diamond legacy
  objects and namespace evidence, emits a privately branded fragment with
  counts/digests, and adopts that fragment into the 0.5 backup flow.

### Changed

- Replaced the public transport handler with an already-authorized,
  transport-neutral SPARQL executor in the `./sparql` subpath.
- Introduced readonly runtime-neutral SQL contracts, explicit adapter
  capabilities, and connection-bound opaque transaction plans.
- Added non-forgeable migration-owner registration, JCS SHA-256 namespace
  slices, and owner-scoped Diamond backup inspection/export/import.

### Removed

- Removed the `./endpoint` export and all routing, authentication, CORS, and
  rate-limit behavior from Diamond.

### Security

- Rejects forged/serialized/cross-connection owner handles and plans, verifies
  backup/evidence digests before mutation, preserves foreign database objects,
  and requires exact outbound SERVICE authorization.

## [0.4.1] - 2026-07-22

### Added

- Added one shared Node SQLite/workerd D1 capability suite proving conditional
  `UPDATE ... RETURNING` claim exclusivity, ordered batch metadata, rollback at
  every statement boundary and commit, concurrent calls, persisted reopen,
  migration recovery/drift refusal, scalar round-trips, and BLOB round-trips.
- Added `readSqliteBytes()` to normalize the runtime-native BLOB row shapes:
  Node returns typed bytes while workerd D1 returns a JSON-compatible byte
  array.
- Added portable text/BLOB byte measurement and bound enforcement helpers.

### Fixed

- Prevented native SQLite integer precision loss: unsafe numeric bindings are
  rejected, safe integer rows remain numbers, and larger integer rows remain
  `bigint`. The shared suite records workerd D1's explicit bigint rejection.
- Expanded the exact packed-package consumer to compose caller-owned rows with
  a prepared RDF patch and verify persisted BLOB and integer fidelity.

### Security

- Temporarily overrode Miniflare's development-only Sharp dependency to
  `0.35.3` while Cloudflare prepares its supported upgrade, clearing the
  inherited libvips advisory without weakening the repository audit gate.

## [0.4.0] - 2026-07-21

### Added

- Added SQLite-neutral capability names while preserving the existing D1
  declarations and runtime classes.
- Added the isolated `@gnolith/diamond/node-sqlite` embedded adapter with
  same-connection atomic batching and explicit lifecycle.
- Added a namespaced, checksummed migration ledger and conservative legacy
  Diamond schema adoption.

## [0.3.3] - 2026-07-21

### Changed

- Clarified that Diamond owns published-package runtime verification while
  complete-site assembly, provisioning, deployment, and hosted acceptance
  belong to the application-creating agent.
- Replaced packaged Codex Sites deployment scaffolding and deployed probes with
  platform-neutral consumer validation and application examples.
- Documented `nodejs_compat` as a published Worker runtime prerequisite and
  added exact-package Wrangler/Miniflare D1 write/read coverage for that
  contract.

## [0.3.2] - 2026-07-20

### Added

- Transaction-composable quad patch preparation for atomically batching RDF
  changes with caller-owned D1 statements.

## [0.3.1] - 2026-07-20

### Changed

- Replaced the temporary npm release token with repository- and
  environment-bound OIDC trusted publishing.
- Disabled the dependency cache in release jobs so published builds start from
  a clean dependency installation.

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
