# Changelog

All notable changes will be documented here. Versions follow Semantic
Versioning after the first public release.

## [Unreleased]

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
