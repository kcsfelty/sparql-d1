# Threat model

## Protected assets

- D1 data confidentiality and integrity
- Worker CPU, memory, subrequests, and database quotas
- Internal network and third-party endpoints reachable through `fetch`
- Authentication tokens and operational telemetry

## Trust boundaries

SPARQL text, HTTP headers, content negotiation, and authentication credentials
are untrusted. The D1 binding and package configuration are trusted host inputs.

## Primary threats and controls

| Threat                  | Default control                                            |
| ----------------------- | ---------------------------------------------------------- |
| Unauthorized reads      | Host-provided authentication hook                          |
| Unauthorized writes     | Read-only endpoint; Update requires opt-in                 |
| SSRF through federation | `SERVICE` requires a per-target URL policy                 |
| SSRF through RDF import | Remote SPARQL `LOAD` is rejected at the HTTP boundary      |
| Query explosion         | Streamed input bound, algebra limits, one request deadline |
| Oversized output        | Bounded serialized stream and cancellation                 |
| SQL injection           | Fixed SQL structure and bound term keys                    |
| Cross-graph disclosure  | Host owns endpoint authorization and dataset scope         |
| Error disclosure        | Unexpected server errors are redacted by default           |
| Supply-chain compromise | Lockfile, dependency review, CodeQL, audit, Dependabot     |

## Residual risks

Algebra size is only a proxy for execution cost. Small property-path or join
queries can still be expensive. Public deployments should add platform rate
limits, per-principal authorization, logging, and conservative Worker limits.
Enabling `SERVICE` requires a destination policy. The supplied
`allowServiceUrls()` helper performs exact canonical matching; dynamic targets,
embedded credentials, and non-HTTP(S) schemes are rejected independently.
Comunica receives a policy-wrapped fetch transport that rechecks every outbound
URL and rejects redirects, closing redirect-based SSRF bypasses. DNS and the
behavior of an explicitly trusted service remain deployment trust decisions.
POST size enforcement covers the entire encoded body and cancels the reader at
the limit. Synchronous parser code cannot be interrupted mid-call, so bounded
input is retained even though one absolute deadline covers the full expensive
request path and is checked immediately after parsing.

Writable endpoints require `readOnly: false` and stronger host authorization.
Updates are never accepted through GET or a query media type, avoiding a
state-changing surface that link traversal or prefetching could invoke. Each
complete RDF/JS write stream is one atomic D1 statement; D1 does not expose a
transaction spanning arbitrary Comunica callbacks, so hosts should not present
multi-operation requests as a broader ACID transaction guarantee.

Remote `LOAD` is rejected even in writable mode because it combines mutation
with an attacker-selected server-side fetch. Applications may import trusted
RDF outside the SPARQL HTTP endpoint after applying their own origin, size,
content-type, redirect, and authorization controls.
