# Wikibase-style statements without Wikibase

This application-layer example maps ranked statements, qualifiers, grouped
references, full values, `somevalue`/`novalue` markers, best-rank annotations,
truthy projections, and entity revisions to ordinary RDF/JS quads. It does not
add Wikibase behavior to Diamond core and it does not depend on Wikipedia,
Wikidata, or a Wikibase service.

`buildWikibaseStyleEntityQuads()` is the domain mapping. The example deliberately
uses a site-owned base IRI for entities, properties, statements, references, and
special-value markers. Statement and reference IRIs are entity-scoped, so the
same local statement ID in two entities cannot merge their closures. Statement
IDs must be unique within one entity document; reference IDs must be unique
across that entity's statements. Empty or duplicate IDs are rejected before a
patch is attempted. `replaceWikibaseStyleEntity()` replaces the complete
entity-owned closure through `applyQuadPatch()`. Its revision quad is supplied
as a transactional precondition, so two edits based on the same revision cannot
both commit.

Full-value quads supplied to this example must be owned by the entity closure;
do not include shared quads that another entity expects to retain. Production
applications should validate property datatypes and command authorization before
building the replacement document. Keep SPARQL execution read-only and expose
editing through authorized, application-owned commands.

The module includes create, complete-entity replace/delete, statement
add/replace/delete, and rank-change commands. Every statement edit rebuilds the
complete entity closure so `wikibase:BestRank` and direct truthy triples are
derived again in the same transaction. Creation atomically forbids an existing
site-owned entity marker, so repeating it throws `QuadPatchConflictError`
instead of merging state. Later commands use the revision quad to reject stale
edits with the same error.

Authoritative facts are the entity-to-statement link, main value, qualifiers,
references, and rank. Direct predicates under `prop/direct/` are a derived
truthy projection calculated independently for each property: preferred
statements win; otherwise normal statements are projected; deprecated-only
values are omitted.

Statement and reference resources are typed as `wikibase:Statement` and
`wikibase:Reference`. This does not make the mapping a byte-compatible Wikibase
RDF export. In particular, `somevalue` and `novalue` are stable site-owned named
nodes linked through the relevant simple-value predicate and typed with the
site-owned `schema/SomeValue` or `schema/NoValue` class. This explicit mapping
is queryable and round-trippable for this application, but intentionally does
not claim Wikibase's OWL-based special-value export semantics. No compatibility
mode is provided without a concrete interoperability target and differential
fixtures; that concern belongs in a separate adapter if it becomes necessary.

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
  ?some a <https://site.example/rdf/schema/SomeValue>.
  ?none a <https://site.example/rdf/schema/NoValue>.
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
and special values, rejects duplicate identities and repeated creation, proves
cross-entity ID isolation, exercises add/delete/rank lifecycle operations and
deprecated-only rank behavior, rejects a stale edit, and queries through the
transport-neutral SPARQL executor without an external service.
