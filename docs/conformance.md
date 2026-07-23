# Conformance

Diamond runs the applicable RDF/JS source/store and SPARQL query/update
manifests, with dedicated tests for serializers and execution-policy boundaries.
Protocol mapping is deliberately outside this package and belongs to the host.

Use `npm run conformance` for the summary and `npm run conformance:earl` for
EARL output. Known upstream manifest coverage limitations are reported by the
runner rather than treated as implicit support.
