# Deployed Codex Sites validation

## Clean-room release gate

An independent clean-room run of the first `0.1.0` candidate (commit
`c64e32b`, SHA-256
`8AFB2C7E25FD1AA6FDBBE29C6F19588A849B10411C52AA10AB8544A4EFDED95B`)
failed on 2026-07-19. Production Worker ASK-to-XML serialization returned HTTP
500, and the deployed probe script was absent from the archive. That artifact
must not be released. The repository now has bundled-Worker ASK/SELECT XML
regressions and artifact-presence checks; an independent clean-room rerun of a
new archive remains required before release.

## Earlier private integration proof

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

Run the destructive-but-self-cleaning probe from an installed package against
an authorized test endpoint with:

```sh
SPARQL_ENDPOINT=https://example.test/api/sparql npm run test:deployed
```

To prove the packed command is executable rather than accidentally using a
source checkout, a consumer can run it with `npm explore sparql-d1 -- npm run
test:deployed` while supplying the same environment variables.

For an authenticated endpoint, also set `SPARQL_AUTH_HEADER` and
`SPARQL_AUTH_TOKEN`. An owner-only Site has a separate outer access gate. For
an identity-less automated probe, obtain a short-lived Sites test-bypass token
through the Sites deployment tooling and set both
`SPARQL_OUTER_AUTH_HEADER=OAI-Sites-Authorization` and
`SPARQL_OUTER_AUTH_TOKEN`. Never put either token in source or command output.
The script sends both bearer headers, checks SPARQL Results XML in addition to
the mutation/read/security sequence, generates a unique graph, and attempts
cleanup in `finally`. Do not point it at a read-only or production-data
endpoint.
