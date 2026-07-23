# Threat model

Diamond treats SPARQL text, backup bytes, migration evidence, owner handles, and
prepared plans as untrusted at their public boundaries.

| Threat                           | Control                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Unauthorized writes              | Read-only executor default; host authorizes transport before calling                                              |
| Query exhaustion                 | Query/result byte, algebra depth/count, deadline, and cancellation bounds                                         |
| SSRF                             | Federation off by default; exact target authorization; dynamic targets, credentials, LOAD, and redirects rejected |
| Migration namespace theft        | Privately branded owner handle bound to authority, installation, manifest, namespace, and connection              |
| Evidence tampering               | JCS SHA-256 verified before live-state access or mutation                                                         |
| Cross-database transaction plans | Private plan provenance and adapter-level foreign-statement rejection                                             |
| Backup overreach                 | Fixed Diamond owner/tables/ledger slice; foreign objects left untouched                                           |
| Partial import                   | Payload checksum before mutation and one atomic payload batch; explicit schema restore or migration-bound mode    |
| Silent RDF loss                  | Rebuild is an explicit non-import report                                                                          |
| Node leakage                     | `node:sqlite` exists only in the optional native subpath                                                          |

The host remains responsible for authentication, authorization, tenant dataset
selection, rate limiting, origin policy, logging privacy, and mapping executor
results onto its chosen transport.
