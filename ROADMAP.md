# Roadmap

## Completed public foundation

- D1 RDF/JS Source and Store contracts
- SPARQL Protocol endpoint and secure defaults
- Workerd D1 integration and differential tests
- Public repository, protected CI, and reproducible provenance-bearing releases

## Completed conformance and deployment evidence

- W3C manifest runner and documented exclusions
- Expanded generated query/dataset differential coverage
- Deployed Codex Sites end-to-end fixture
- Cancellation, concurrent access, and migration rollback suites

## Completed 0.2 performance work

- Opt-in paginated pattern reads and cancellation
- Dictionary-encoded storage evaluation and redundant-index removal
- D1 rows-read, Worker CPU, memory, and call-count baselines
- Evidence-backed decision that whole-algebra SQL pushdown does not belong
  behind an RDF/JS `sourceFactory`

## Completed public release

- Independent integration exercise
- API and naming review
- Complete dependency-license and intellectual-property audit
- Public maintainer and security contacts
- Version 0.1.0 release with provenance and explicit experimental API status

## Future experimental work

- Production-guided pagination defaults and larger deployed benchmarks
- A focused RFC for whole-algebra execution through a Comunica actor, custom
  engine, or companion package
- A D1 migration/rollback study before any dictionary-encoded storage change
- Trusted-publisher migration and removal of the temporary npm-token fallback

## Stable release

- Version 1.0.0 after production feedback and a migration stability commitment
