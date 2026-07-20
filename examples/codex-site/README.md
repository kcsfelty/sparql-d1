# Codex Sites example

Copy this example's `app`, `drizzle`, and `.openai` files into a fresh Sites
project. The hosting declaration binds D1 as `DB`; Sites packages the Drizzle
migration for its managed database. Install a packed private artifact as
described in the repository README and configure `SPARQL_TOKEN` through Sites
runtime values. Do not commit the token or place it in `.openai/hosting.json`.

The example deliberately fails closed when no token is configured. A real site
may replace the bearer check with its existing identity and authorization
layer.

The complete clean-project validation and sign-off checklist is in
`docs/integration-validation.md` at the repository root.
