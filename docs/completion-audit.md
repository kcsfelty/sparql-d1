# Completion audit

This matrix maps the project definition of done to evidence that can be
reproduced from the repository. A green structural check is not substituted
for behavioral evidence.

| Requirement                                                                                         | Status                                      | Authoritative evidence                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete RDF/JS Source pattern contract                                                             | Proven                                      | `test/source.test.ts` enumerates all 16 bound/unbound masks                                                                                     |
| Lossless RDF terms, graphs, blank nodes, language, datatypes, and RDF 1.2 quoted triples            | Proven                                      | generated and example cases in `test/term-codec.test.ts`                                                                                        |
| SPARQL equivalence to a trusted in-memory store                                                     | Proven for the supported query corpus       | `test/differential.test.ts` compares D1 with N3                                                                                                 |
| Applicable W3C behavior                                                                             | Proven with explicit scope                  | 490/490 cases and literal exclusions in `docs/conformance.md`                                                                                   |
| SPARQL Protocol operation separation and result negotiation                                         | Proven                                      | protocol and all nine serializer cases in `test/endpoint.test.ts`                                                                               |
| Secure read-only default; explicit update/federation opt-in; remote LOAD rejection                  | Proven                                      | endpoint tests plus `docs/threat-model.md`                                                                                                      |
| Authentication, rate-limit hook, complexity, deadline, cancellation, output limit, and SSRF policy  | Proven                                      | dedicated endpoint tests, including redirect rejection and outbound reauthorization                                                             |
| Schema, atomic quad patches, failed-batch rollback, concurrency, HTTP streaming, and D1 behavior    | Proven within documented D1 semantics       | source/workerd integration tests and endpoint stream tests                                                                                      |
| Performance baseline for latency, CPU, memory, D1 calls, and rows read                              | Proven as a reproducible baseline           | `npm run benchmark:check` and `docs/performance.md`                                                                                             |
| Bounded pattern pagination and cancellation                                                         | Proven with documented consistency tradeoff | all-mask source tests, workerd multi-page/cancellation tests, and the paged benchmark                                                           |
| SQL algebra pushdown boundary                                                                       | Evaluated; proposed boundary not viable     | `docs/sql-pushdown-decision.md` and the Comunica RDF/JS pattern contract                                                                        |
| Physical storage/index choice                                                                       | Evaluated; safe index change shipped        | `npm run benchmark:storage:check`, `docs/storage-evaluation.md`, and migration 0002                                                             |
| Supported Node versions and module-Worker portability                                               | Proven for maintained local fixtures        | hosted Node 22/24, Wrangler dry-run bundling, Miniflare/workerd runtime tests, quality, benchmark, and conformance checks                       |
| Reproducible release artifacts, SemVer, changelog, SBOM, checksums, attestation, and npm provenance | Proven by public 0.1.0 release              | `scripts/release-check.mjs`, pinned release workflow, npm provenance, and GitHub release                                                        |
| Documentation, licensing, contribution, governance, support, roadmap, and maintenance material      | Proven structurally and reviewed            | `npm run readiness:check` and the named repository files                                                                                        |
| Continuous dependency, license, secret, vulnerability, and supply-chain checks                      | Proven                                      | green audit, Gitleaks, CodeQL SARIF, Dependabot, immutable Action pins, and license allowlist                                                   |
| Independent exact-package consumption                                                               | Reproducible                                | `npm run consumer:check` packs, installs, imports, bundles, and executes the public Worker entry in a fresh temporary project                   |
| Final public-release review and governance                                                          | Public release complete                     | public repository/package, MIT license, Issues policy, sole-maintainer policy, and provenance release; trusted-publisher cleanup is operational |

## Semantic qualifications

D1 guarantees atomic execution for the package's single-statement RDF write
streams and transactional failure of migration batches. It does not expose a
transaction spanning arbitrary callbacks made by a SPARQL engine. Accordingly,
the package does not claim request-wide ACID semantics for a compound update.

The HTTP result body is streamed, bounded, and cancellable. The default D1
source buffers one complete quad-pattern result; opt-in keyset pagination
bounds source memory with the documented cross-page consistency and call-count
tradeoff. SQL algebra pushdown is not available through the RDF/JS source
factory; the evidence-backed boundary decision is documented separately.

This audit is limited to Diamond's package and supported local runtimes. The
agent assembling an application owns its bindings, secrets, provisioning,
deployment, and hosted acceptance evidence.
