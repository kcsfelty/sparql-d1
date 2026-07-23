# Open-source readiness

The release gate checks formatting, linting, strict types, 90% coverage,
runtime-neutral and native conformance, build output, examples, artifact
inventory, packed-consumer execution, dependency licenses, security policy,
support policy, and release metadata.

The package includes root storage, `./sparql`, `./backup`, and
`./node-sqlite`. It excludes transport handlers and hosted deployment
machinery. Tagging, publishing, and release creation remain separate protected
release actions.
