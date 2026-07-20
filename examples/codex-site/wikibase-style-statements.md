# Wikibase-style statements without Wikibase

This application-layer example maps ranked statements, qualifiers, grouped
references, full values, `somevalue`/`novalue` markers, best-rank annotations,
truthy projections, and entity revisions to ordinary RDF/JS quads. It does not
add Wikibase behavior to `sparql-d1` core and it does not depend on Wikipedia,
Wikidata, or a Wikibase service.

`buildWikibaseStyleEntityQuads()` is the domain mapping. The example deliberately
uses a site-owned base IRI for entities, properties, statements, references, and
special-value markers. `replaceWikibaseStyleEntity()` replaces the complete
entity-owned closure through `applyQuadPatch()`. Its revision quad is supplied
as a transactional precondition, so two edits based on the same revision cannot
both commit.

Full-value quads supplied to this example must be owned by the entity closure;
do not include shared quads that another entity expects to retain. Production
applications should validate property datatypes and command authorization before
building the replacement document. Keep the public SPARQL endpoint read-only and
expose editing through authenticated, application-owned commands.

The module includes create, complete-entity replace/delete, statement replace,
and rank-change commands. Statement and rank edits rebuild the complete entity
closure so `wikibase:BestRank` and direct truthy triples are derived again in
the same transaction. Creation assumes the application allocated a new entity
identifier; later commands reject stale revisions with
`QuadPatchConflictError`.

Authoritative facts are the entity-to-statement link, main value, qualifiers,
references, and rank. Direct predicates under `prop/direct/` are a derived
truthy projection calculated independently for each property: preferred
statements win; otherwise normal statements are projected; deprecated-only
values are omitted.

Representative queries (using the base `https://site.example/rdf/`) are:

```sparql
# Best/truthy values
SELECT ?value WHERE {
  <https://site.example/rdf/entity/Q1>
    <https://site.example/rdf/prop/direct/P1> ?value
}

# Full statements, rank, qualifier, and grouped reference snaks
SELECT ?statement ?rank ?qualifier ?reference ?source ?page WHERE {
  <https://site.example/rdf/entity/Q1>
    <https://site.example/rdf/prop/P1> ?statement.
  ?statement <http://wikiba.se/ontology#rank> ?rank;
    <https://site.example/rdf/prop/qualifier/P2> ?qualifier;
    <http://www.w3.org/ns/prov#wasDerivedFrom> ?reference.
  ?reference <https://site.example/rdf/prop/reference/P3> ?source;
    <https://site.example/rdf/prop/reference/P6> ?page.
}

# Special values
SELECT ?some ?none WHERE {
  ?statement <https://site.example/rdf/prop/qualifier/P4> ?some;
    <https://site.example/rdf/prop/qualifier/P5> ?none.
  FILTER(CONTAINS(STR(?some), "/special/somevalue/"))
  FILTER(CONTAINS(STR(?none), "/special/novalue/"))
}

# Multi-hop entity values
SELECT ?first ?second WHERE {
  <https://site.example/rdf/entity/Q1>
    <https://site.example/rdf/prop/direct/P1> ?first.
  ?first <https://site.example/rdf/prop/direct/P1> ?second.
}
```

The executable `npm run example:check` check applies a revision replacement,
verifies best-rank recomputation and grouped reference values, exercises full
and special values, rejects a stale second edit, and queries the result through
the normal SPARQL HTTP handler without an external service.
