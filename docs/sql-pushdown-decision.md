# SQL algebra pushdown decision

Issue #8 proposed pushing joins, filters, projection, ordering, and limits
behind `sourceFactory`. Investigation found that boundary cannot implement the
proposal correctly.

`sourceFactory` returns an RDF/JS `Source`. Comunica adapts that source as a
pattern query source and selects it for individual quad-pattern operations;
the adapter rejects non-pattern operations. Basic graph patterns, joins,
projection, ordering, and limits are planned and evaluated above that RDF/JS
interface, so the factory never receives the algebra it would need to compile
one joined SQL statement. Calling another object a source would not change this
contract, and inferring joins from a sequence of `match()` calls would break
SPARQL multiset, OPTIONAL, correlation, graph, and cancellation semantics.

Decision: do not ship a misleading or partial “SQL pushdown” mode behind
`sourceFactory`. The option remains useful for semantically equivalent pattern
sources, including the new paginated reader. A real pushdown experiment needs
a separate integration at Comunica's query-source actor or execution-engine
layer, a supported-algebra matrix, explicit fallback, observation labels, and
differential/conformance tests. That work should begin with a focused RFC and
may be better isolated in a companion package so this small RDF/JS adapter does
not replace the query engine it integrates with.

The current benchmark continues to expose the relevant cost: Comunica joins
can cause multiple D1 calls and rows read. This is an acknowledged optimization
opportunity, but the proposed extension point is closed as not planned because
it cannot satisfy the issue's correctness requirements.
