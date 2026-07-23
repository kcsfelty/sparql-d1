# Integration validation

`npm check` validates both structural D1-compatible databases and the optional
Node adapter against the shared SQLite capability suite. It also installs the
exact packed artifact in a temporary consumer and imports all four public
graphs.

The packed consumer initializes a native in-memory store and executes SPARQL
through `@gnolith/diamond/sparql`. Artifact inventory rejects removed network,
authentication, and CORS symbols and verifies that the endpoint subpath is
absent.

No validation step provisions or deploys a hosted resource.
