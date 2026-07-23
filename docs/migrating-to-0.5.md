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
- `migration-bound` requires the exact schema and ledger evidence already live.
- `rebuild` imports nothing and returns `rebuild-required`; the host must rebuild
  RDF through its own trusted path.
