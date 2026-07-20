# Independent clean-room agent prompt

Use this prompt in a new, projectless Codex task with no inherited conversation
or configured project. Replace only `ARTIFACT_PATH` and `EVIDENCE_PATH`.

> Independently validate `sparql-d1` as a developer encountering it for the
> first time. Start in an empty working directory. You may use only the package
> archive at `ARTIFACT_PATH` and the README, example, and documentation packed
> inside it. Do not inspect another checkout of the source repository, reuse an
> existing Site, or ask the author for undocumented setup instructions.
>
> Create a new owner-only Codex Site, install the archive, configure its D1
> binding and migration, add an authenticated read-only SPARQL route, build,
> deploy, and execute every acceptance check in
> `docs/integration-validation.md`. Also create a temporary authenticated
> writable validation route against disposable data, verify insert/read/delete
> behavior, verify SPARQL Results XML for both ASK and SELECT in the production
> Worker, run the packed `npm run test:deployed` procedure from the installed
> package, and verify that both unauthorized access and remote SPARQL `LOAD` are
> rejected. Remove the temporary test data when finished.
>
> Do not silently repair package or documentation defects. Record every
> ambiguity, missing step, failure, workaround, command, package SHA-256,
> package version, Site version, deployment result, HTTP status, and semantic
> assertion. Save the completed sign-off record and a pass/fail conclusion at
> `EVIDENCE_PATH`. A pass requires the documented procedure to work without
> unpublished knowledge.

This validates technical reproducibility, not maintainer bus factor or human
governance. Record the validator as an independent agent.
