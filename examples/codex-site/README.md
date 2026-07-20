# Codex Sites example

Copy this example's `app`, `drizzle`, and `.openai` files into a fresh Sites
project. The hosting declaration binds D1 as `DB`; Sites packages the Drizzle
migration for its managed database. Install a packed private artifact as
described in the repository README and configure `SPARQL_TOKEN` through Sites
runtime values. Do not commit the token or place it in `.openai/hosting.json`.

Deployment applies the copied Drizzle migration to managed D1. A fresh local
`vinext dev` D1 is not initialized by copying the file alone; unless the Sites
starter documents a local migration command, perform the first functional D1
check after an owner-only deployment. The package's Miniflare suite applies and
tests this schema locally under workerd.

The public-facing `/api/sparql` example is read-only and deliberately fails
closed when no token is configured. A real site may replace the bearer check
with its existing identity and authorization layer.

An optional `/api/sparql/admin` example supports SPARQL Update for controlled
validation and administration. It uses a distinct `SPARQL_ADMIN_TOKEN`, fails
closed when that token is absent, and should be removed after validation unless
the deployment requires an administrative endpoint. Never expose it without
strong administrator authentication. Remote `LOAD` remains disabled on both
routes; import trusted RDF through an application-controlled path.

The complete clean-project validation and sign-off checklist is in
`docs/integration-validation.md` at the repository root.
