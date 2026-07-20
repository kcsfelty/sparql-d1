# Open-source readiness

The repository and npm package are public. Diamond was independently validated
before its move to `@gnolith/diamond`; the final clean-room attempt passed every
package, fresh Codex Site, managed-D1, protocol, security, cleanup, and
packed-verifier check on 2026-07-20.

## Completed controls

- MIT licensing, contribution, conduct, governance, security, support,
  roadmap, changelog, maintainer, issue-template, and CODEOWNERS files.
- Public API, experimental storage format, threat model, performance limits,
  and explicit W3C exclusions.
- Green Windows and GitHub-hosted Node 22/24 checks, workerd D1 tests,
  conformance, benchmarks, audit, license, secret, and CodeQL checks.
- Pinned GitHub Actions, automated dependency updates, SBOMs, checksums,
  artifact attestations, and public-repository-only npm provenance publishing.
- A fresh-project independent validation using only the packed public material,
  including real Codex Sites deployment and managed D1, followed by removal of
  temporary writable/schema routes, credentials, and RDF test data.
- Public npm installation is the primary consumer path; packed archives remain
  a maintainer workflow for testing unreleased bytes.

## Operational follow-ups

- Keep main-branch rules, vulnerability alerts, automated security fixes, and
  release workflows enabled as repository settings evolve.
- Replace the temporary short-lived npm release token with npm trusted
  publishing, then remove the fallback GitHub environment secret and workflow
  fallback.
- Continue to state the sole-maintainer bus-factor risk for the experimental
  `0.x` series and use GitHub Issues for public support.

These are operational controls, not hidden package-correctness gates.
