# Migrating to 0.5

0.5.0 intentionally removes `@gnolith/diamond/endpoint` and
`createSparqlHandler`. There is no deprecated compatibility wrapper.

Workshop or another host now owns its transport:

```ts
import { createSparqlExecutor } from '@gnolith/diamond/sparql';

const execute = createSparqlExecutor({ db, policy: { readOnly: true } });

// Inside Workshop, after its own auth, authorization, rate limit, and CORS:
const result = await execute({
  operation: parsedOperation,
  text: parsedSparql,
  accept: request.headers.get('accept') ?? undefined,
  signal: request.signal,
});
return new Response(result.body, {
  status: result.status,
  headers: result.mediaType ? { 'content-type': result.mediaType } : {},
});
```

Storage code should replace direct use of `plan.statements` in composed
transactions with `statementsForQuadPatch(db, plan)`. This validates provenance
before execution.

Assemblies that back up shared databases must create one migration assembly
authority per installation, register Diamond's namespace/manifest, and retain
the resulting in-memory handle. Serialized lookalikes are deliberately invalid.
Use `createMigrationLedgerBackupV1()` for evidence and
`createDiamondBackupV1()` for the Diamond section.

Backup restore choices are explicit:

- `empty` creates Diamond's migration-bound schema and imports its RDF.
- `migration-bound` requires the exact schema and compatible migration IDs and
  checksums already live. Independent application timestamps need not match.
- `rebuild` imports nothing and returns `rebuild-required`; the host must rebuild
  RDF through its own trusted path.

Use `validateDiamondBackupSectionV1(section)` for database-free archive
verification. To test restore readiness, initialize a separate scratch target,
register the same Diamond manifest, then call `dryRunImport(section,
{mode: 'migration-bound'})`. Never use the populated source as an import target.

For an exact detached 0.4.1 database, use the read-only compatibility seam:

```ts
import {
  adoptDiamond041LegacyOwnerV1,
  decodeDiamond041LegacyOwnerV1,
} from '@gnolith/diamond/backup';

const fragment = await decodeDiamond041LegacyOwnerV1({
  source: readOnlySource,
  attestation: {
    packageName: '@gnolith/diamond',
    packageVersion: '0.4.1',
  },
});
const section = adoptDiamond041LegacyOwnerV1(fragment);
```

The decoder neither opens nor mutates the source. It recognizes only the exact
legacy Diamond tables/indexes and Diamond namespace ledger row, applies bounded
row/byte limits, and exposes counts/digests without exposing payload bytes.
