# Conformance report

## Result

`npm run conformance` executes the current W3C SPARQL 1.1 manifest through
`rdf-test-suite` with `conformance/engine.cjs`, loading every test dataset into
the D1 adapter before Comunica evaluates the query or update.

As of 2026-07-19, **490 of 490 applicable manifest cases pass**. The command is
a required GitHub Actions job. CI retains both its human-readable summary and
an RDF EARL report as artifacts; `npm run conformance:earl` reproduces the
machine-readable report locally.

## Scope exclusions

| Area                               | Reason                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entailment regimes                 | The package is a simple RDF dataset and provides no RDF(S), OWL, RIF, or custom inference layer.                                                                                                                                                                |
| Federated `SERVICE` evaluation     | Disabled by default and excluded as an SSRF boundary. Syntax rejection/acceptance is covered locally.                                                                                                                                                           |
| SPARQL Protocol manifest           | `rdf-test-suite` does not implement the Protocol test interface. The endpoint has dedicated request/response tests instead.                                                                                                                                     |
| Graph Store HTTP Protocol          | The package exposes a SPARQL endpoint, not a Graph Store endpoint.                                                                                                                                                                                              |
| Eight redirected named-graph cases | The current manifest loader retains legacy `http://w3c.github.io/` graph labels while expected files use redirected `https://` IRIs. The exact IDs are listed below. Equivalent named-graph behavior is covered by local differential and D1 integration tests. |

The eight harness-incompatible IDs are:

- `aggregates/manifest#agg-empty-group-count-graph`
- `bindings/manifest#graph`
- `construct/manifest#constructwhere04`
- `exists/manifest#exists03`
- `exists/manifest#exists-graph-variable`
- `property-path/manifest#pp34`
- `property-path/manifest#pp35`
- `subquery/manifest#subquery02`

These exclusions are encoded literally in the npm command so a new skip cannot
be introduced silently. Remove them when the upstream manifests or loader use
one canonical graph IRI.

## What this proves

The result proves the applicable SPARQL 1.1 query/update behavior when Comunica
uses this package as its RDF/JS Store. It does not prove inference support,
unbounded production workloads, or the behavior of a deployed network edge;
those are separate operational gates.
