# Deployed Codex Sites validation

## Clean-room release gate

The third independent clean-room run passed on 2026-07-20 using the exact
`0.1.0` archive identified by SHA-256
`5A5C4FC528258C86E03B34A9B0375F225BA81AE8C0D3897E849AFCFBF7C0CD90`.
An independent Codex agent started with a new directory, new Site, new managed
D1 database, and only packed public-facing material. It verified both
authentication boundaries, JSON/XML/RDF results, read-only enforcement,
SERVICE and LOAD rejection, disposable named-graph write/read/delete, the
packed deployed probe, and the packed schema verifier. It then removed the
temporary writable/schema routes, administrator secret, and all RDF test data;
the final Site retained only the authenticated read-only route. Overall result:
PASS.

Two earlier candidates are retained as useful negative evidence. Candidate
`c64e32b` exposed a production Worker XML defect and missing packed probe.
Candidate `4a0e008` passed runtime behavior but revealed that the written gate
lacked an executable managed-catalog check. Both defects were corrected before
the passing third run.

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

### Managed D1 catalog verification

Temporarily mount the packed `examples/codex-site/app/api/sparql/schema/route.ts`
and configure `SPARQL_ADMIN_TOKEN`. Then run the installed verifier with the
schema endpoint and the same two authentication layers:

```sh
SPARQL_SCHEMA_ENDPOINT=https://example.test/api/sparql/schema \
SPARQL_AUTH_HEADER=Authorization \
SPARQL_AUTH_TOKEN=admin-token \
SPARQL_OUTER_AUTH_HEADER=OAI-Sites-Authorization \
SPARQL_OUTER_AUTH_TOKEN=sites-bypass-token \
npm explore sparql-d1 -- npm run test:deployed:schema
```

PowerShell users can set the same values without POSIX inline assignment:

```powershell
$env:SPARQL_SCHEMA_ENDPOINT='https://example.test/api/sparql/schema'
$env:SPARQL_AUTH_HEADER='Authorization'
$env:SPARQL_AUTH_TOKEN='<admin token>'
$env:SPARQL_OUTER_AUTH_HEADER='OAI-Sites-Authorization'
$env:SPARQL_OUTER_AUTH_TOKEN='<Sites bypass token>'
npm explore sparql-d1 -- npm run test:deployed:schema
```

The verifier fails unless the deployed catalog contains strict `rdf_quads` and
`rdf_patch_guards` tables and the four effective indexes (the UNIQUE autoindex
plus three named cyclic indexes) in exact column order. Remove the temporary
schema route, admin route, and administrator token afterward.
