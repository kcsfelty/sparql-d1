# Testing strategy

The repository uses layered evidence rather than treating one green suite as
proof of the entire system.

| Layer          | Evidence                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Term codec     | Examples plus generated Unicode literal cases                           |
| RDF/JS source  | Every one of the 16 quad-pattern binding masks                          |
| Storage        | Strict schema, uniqueness, named/default graph behavior                 |
| Differential   | Identical Comunica queries over D1 and an N3 reference store            |
| Protocol       | GET/POST, formats, auth, limits, cancellation, SERVICE/LOAD controls    |
| Update         | Explicit opt-in, atomic stream completion, later read visibility        |
| D1             | Miniflare/workerd binding, concurrent writes, batch rollback            |
| Worker runtime | Wrangler dry-run bundle plus local Miniflare/workerd execution          |
| Consumer       | Pack/install exact bytes; import and run the public Worker entry        |
| Application    | Execute the Wikibase-style revision/statement usage example             |
| Performance    | Buffered/paged D1, SPARQL, and storage: latency, CPU, heap, calls, rows |
| Conformance    | 490/490 applicable W3C SPARQL 1.1 manifest cases                        |

Coverage gates are 90% for statements, branches, functions, and lines. Type
declarations and the export-only barrel are excluded because execution
coverage is not meaningful for them.

The conformance job fetches the W3C-maintained manifest and records both a
summary and an RDF EARL report as CI artifacts. Every excluded area and
individual compatibility exception is listed in `docs/conformance.md` and
encoded in the runner. The wrapper also asserts that exactly 490 results were
produced; this prevents an upstream loading fault from becoming an empty green
run.

Complete-site assembly, provisioning, deployment, and hosted acceptance are
outside this repository's test boundary and belong to the agent creating that
site.
The reproducible multi-scenario baseline and interpretation are in
`docs/performance.md`.
The physical-layout benchmark and decision are in
`docs/storage-evaluation.md`.
The definition-of-done evidence map and semantic qualifications are in
`docs/completion-audit.md`; open-source structure and release wiring are
checked by `npm run readiness:check`.

## Temporary Miniflare Sharp override

Miniflare `4.20260714.0` pins development-only `sharp@0.34.5`, which is affected
by inherited libvips advisory
[`GHSA-f88m-g3jw-g9cj`](https://github.com/advisories/GHSA-f88m-g3jw-g9cj).
Diamond temporarily overrides that transitive dependency to exact
`sharp@0.35.3`. This is outside Miniflare's declared dependency contract; it is
not evidence that arbitrary Miniflare Images behavior is supported. The raw
`npm audit --audit-level=high` gate remains unchanged and must report no high
or critical vulnerability.

The override was qualified on Node 22 for Windows x64 and Linux x64 with the
complete package check, including real workerd D1, the bundled Worker, local
Worker execution, the packed consumer, and all 490 W3C summary and EARL
assertions. Windows Node 24 also passed. One isolated dependency-compatibility
probe transformed a known PNG to WebP and verified the output format,
dimensions, checksum, and dynamically loaded Sharp native module on both
operating systems. That probe is not a Diamond Images feature or support
claim.

AVIF/HEIF is specifically outside this qualification. Sharp 0.35 reports AVIF
input metadata as `heif`, and the pinned Miniflare release does not contain the
corresponding format-mapping update. Cloudflare is addressing the dependency
and mapping together in
[`workers-sdk#14493`](https://github.com/cloudflare/workers-sdk/pull/14493).
The temporary risk and qualification record are tracked in
[`gnolith/diamond#49`](https://github.com/gnolith/diamond/issues/49).

Remove the override and regenerate the lockfile as soon as Diamond upgrades to
a released Miniflare/Wrangler pair that declares a non-vulnerable Sharp version
and the unmodified audit, real-D1, Worker, packed-consumer, and W3C gates pass.
Do not broaden or retain the override merely to preserve historical lockfile
resolution.
