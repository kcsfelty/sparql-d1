# Open-source readiness

The repository and npm package are public. Diamond's repository gates validate
the source, exact package artifact, and supported local Node and Worker
runtimes. They do not assemble, provision, deploy, or accept a complete site.

## Completed controls

- MIT licensing, contribution, conduct, governance, security, support,
  roadmap, changelog, maintainer, issue-template, and CODEOWNERS files.
- Public API, experimental storage format, threat model, performance limits,
  and explicit W3C exclusions.
- Green Windows and GitHub-hosted Node 22/24 checks, workerd D1 tests,
  conformance, benchmarks, audit, license, secret, and CodeQL checks.
- Pinned GitHub Actions, automated dependency updates, SBOMs, checksums,
  artifact attestations, and public-repository-only npm provenance publishing.
- Repository- and release-environment-bound npm OIDC trusted publishing with no
  long-lived token in the release workflow.
- A fresh temporary consumer installation of the exact packed artifact that
  imports both public entry points, bundles the endpoint with `nodejs_compat`,
  and executes it in local workerd without relying on source-checkout files.
- Public npm installation is the primary consumer path; packed archives remain
  a maintainer workflow for testing unreleased bytes.

## Operational follow-ups

- Keep main-branch rules, vulnerability alerts, automated security fixes, and
  release workflows enabled as repository settings evolve.
- Continue to state the sole-maintainer bus-factor risk for the experimental
  `0.x` series and use GitHub Issues for public support.

These are operational controls, not hidden package-correctness gates.

Application agents own their hosting declarations, route assembly, managed
resources, secrets, deployment, and hosted acceptance evidence.
