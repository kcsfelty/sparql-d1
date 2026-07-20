# Completion audit

This matrix maps the project definition of done to evidence that can be
reproduced from the repository. A green structural check is not substituted
for behavioral evidence.

| Requirement                                                                                         | Status                                    | Authoritative evidence                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimal Codex Sites installation, D1 binding, migration, and route                                  | Proven for the maintained example         | `examples/codex-site`, the packed-consumer check, and `docs/deployed-e2e.md`                                                                |
| Complete RDF/JS Source pattern contract                                                             | Proven                                    | `test/source.test.ts` enumerates all 16 bound/unbound masks                                                                                 |
| Lossless RDF terms, graphs, blank nodes, language, datatypes, and RDF 1.2 quoted triples            | Proven                                    | generated and example cases in `test/term-codec.test.ts`                                                                                    |
| SPARQL equivalence to a trusted in-memory store                                                     | Proven for the supported query corpus     | `test/differential.test.ts` compares D1 with N3                                                                                             |
| Applicable W3C behavior                                                                             | Proven with explicit scope                | 490/490 cases and literal exclusions in `docs/conformance.md`                                                                               |
| SPARQL Protocol operation separation and result negotiation                                         | Proven                                    | protocol and all nine serializer cases in `test/endpoint.test.ts`                                                                           |
| Secure read-only default; explicit update/federation opt-in; remote LOAD rejection                  | Proven                                    | endpoint tests plus `docs/threat-model.md`                                                                                                  |
| Authentication, rate-limit hook, complexity, deadline, cancellation, output limit, and SSRF policy  | Proven                                    | dedicated endpoint tests, including redirect rejection and outbound reauthorization                                                         |
| Schema, failed-batch rollback, concurrency, HTTP streaming, errors, and managed D1                  | Proven within documented D1 semantics     | `test/d1-integration.test.ts`, endpoint stream tests, and the deployed acceptance run                                                       |
| Performance baseline for latency, CPU, memory, D1 calls, and rows read                              | Proven as a reproducible baseline         | `npm run benchmark:check` and `docs/performance.md`                                                                                         |
| Optimization comparison boundary                                                                    | Proven                                    | injectable `sourceFactory` plus the N3 differential semantic oracle                                                                         |
| Supported Node versions and complete CI                                                             | Proven                                    | hosted Node 22/24, quality, benchmark, conformance, and Worker checks                                                                       |
| Reproducible release artifacts, SemVer, changelog, SBOM, checksums, attestation, and npm provenance | Mechanism proven; initial release pending | `scripts/release-check.mjs` and the pinned release workflow; no public tag has been created                                                 |
| Documentation, licensing, contribution, governance, support, roadmap, and maintenance material      | Proven structurally and reviewed          | `npm run readiness:check` and the named repository files                                                                                    |
| Continuous dependency, license, secret, vulnerability, and supply-chain checks                      | Proven                                    | green audit, Gitleaks, CodeQL SARIF, Dependabot, immutable Action pins, and license allowlist                                               |
| Independent clean-room integration                                                                  | Failed first candidate; rerun required    | the `c64e32b` artifact failed Worker XML and packed-probe checks; see `docs/deployed-e2e.md` and repeat `docs/integration-validation.md`    |
| Final public-release review and governance                                                          | Partially complete                        | package name, MIT license, `0.1.0`, Issues policy, and sole-maintainer risk are decided; visibility, ruleset, and npm publisher remain open |

## Semantic qualifications

D1 guarantees atomic execution for the package's single-statement RDF write
streams and transactional failure of migration batches. It does not expose a
transaction spanning arbitrary callbacks made by a SPARQL engine. Accordingly,
the package does not claim request-wide ACID semantics for a compound update.

The HTTP result body is streamed, bounded, and cancellable. The reference D1
source currently buffers each individual quad-pattern result before returning
it to Comunica; pagination and SQL algebra pushdown remain roadmap performance
work, not hidden correctness claims.

The deployed proof used the exact runtime package artifact identified in
`docs/deployed-e2e.md`. Subsequent commits changed documentation, supported
Node metadata, and CI policy, not the deployed query/storage implementation.
