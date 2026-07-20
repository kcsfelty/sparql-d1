# Deployed Codex Sites validation

On 2026-07-19, package commit `34b790c` was installed from its packed artifact
into an owner-only Codex Site and exercised against that site's managed D1 binding at
<https://sparql-d1-e2e-probe.kcsfelty.chatgpt.site/api/sparql>.

The latest proof used saved Site version 3 from Site source commit `94b1209`.
That source vendors the package tarball whose SHA-256 is
`7C6B128B7590584C76D7388609F11F3ADB8A25738388F76FCAE6E2052E7BA32A`.

The acceptance sequence crossed the production HTTP and storage boundary on
every operation:

| Check                                                                     | Result                            |
| ------------------------------------------------------------------------- | --------------------------------- |
| SPARQL Update inserts a language-tagged literal into a named graph        | HTTP 204                          |
| SELECT reads it in a later request with value, language, and graph intact | HTTP 200, one binding             |
| CONSTRUCT serializes it as N-Triples                                      | HTTP 200, expected triple present |
| A federated SERVICE query without a policy is rejected                    | HTTP 403                          |
| DROP removes the temporary graph                                          | HTTP 204                          |

The first deployment exposed a Worker-only compatibility defect: a transitive
Comunica dependency evaluated Node's bare `__dirname` during module startup.
The endpoint now loads Comunica's static engine entry lazily after installing
the Workers-compatible global. A second saved version passed the complete
sequence. This failure is retained here because it demonstrates why a real
deployment test is part of the release process.

Worker telemetry for the version 3 acceptance run recorded:

| Operation        | CPU time | Wall time |
| ---------------- | -------: | --------: |
| INSERT           |   366 ms |    728 ms |
| SELECT           |    71 ms |    186 ms |
| CONSTRUCT        |    40 ms |    121 ms |
| Rejected SERVICE |     4 ms |      6 ms |
| DROP cleanup     |     7 ms |    129 ms |

Earlier successful runs were materially faster after initialization, so these
numbers are observations from one private validation deployment, not
service-level guarantees. Worker logs did not expose heap or D1 `rows_read`;
the deterministic local benchmark reports heap, D1 calls, returned rows, and
latency separately.

Run the same destructive-but-self-cleaning probe against an authorized test
endpoint with:

```sh
SPARQL_ENDPOINT=https://example.test/api/sparql npm run test:deployed
```

For an authenticated endpoint, also set `SPARQL_AUTH_HEADER` and
`SPARQL_AUTH_TOKEN`. The script generates a unique graph and attempts cleanup
in `finally`. Do not point it at a read-only or production-data endpoint.
