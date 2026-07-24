import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('consumer smoke must be run through npm');
const root = mkdtempSync(join(tmpdir(), 'diamond-consumer-'));
try {
  const packOutput = execFileSync(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', root],
    { encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(packOutput);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  execFileSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      root,
      join(root, filename),
    ],
    { stdio: 'inherit' },
  );
  writeFileSync(
    join(root, 'smoke.mjs'),
    `
      import assert from 'node:assert/strict';
      import {
        createMigrationAssemblyAuthorityV1,
        createMigrationLedgerBackupV1,
        diamondMigrationNamespace,
        diamondMigrations,
        initializeStore,
        prepareQuadPatch,
        registerMigrationLedgerOwnerV1,
        statementsForQuadPatch,
      } from '@gnolith/diamond';
      import { createSparqlExecutor } from '@gnolith/diamond/sparql';
      import {
        adoptDiamond041LegacyOwnerV1,
        createDiamondBackupV1,
        decodeDiamond041LegacyOwnerV1,
        validateDiamondBackupSectionV1,
      } from '@gnolith/diamond/backup';
      import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
      if ([initializeStore, prepareQuadPatch, statementsForQuadPatch,
        createSparqlExecutor, createDiamondBackupV1,
        decodeDiamond041LegacyOwnerV1, adoptDiamond041LegacyOwnerV1,
        validateDiamondBackupSectionV1,
        NodeSqliteDatabase]
        .some(value => typeof value !== 'function')) {
        throw new Error('Expected 0.5.0 package exports are unavailable');
      }
      const db = new NodeSqliteDatabase(':memory:');
      await initializeStore(db);
      const result = await createSparqlExecutor({ db })({
        operation: 'query',
        text: 'ASK {}',
      });
      if (result.status !== 200) throw new Error('Packed SPARQL executor failed');

      await db.batch([
        db.prepare(
          \`INSERT INTO rdf_quads
           (subject_key, subject_json, predicate_key, predicate_json,
            object_key, object_json, graph_key, graph_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)\`
        ).bind('s', '"s"', 'p', '"p"', 'o', '"o"', 'g', '"g"'),
      ]);
      const sourceAuthority = createMigrationAssemblyAuthorityV1(
        db, 'packed-coordinate'
      );
      const sourceOwner = await registerMigrationLedgerOwnerV1({
        db,
        installationId: 'packed-coordinate',
        namespace: diamondMigrationNamespace,
        migrations: diamondMigrations,
        assemblyAuthority: sourceAuthority,
      });
      const sourceBackup = createDiamondBackupV1({
        db,
        owner: sourceOwner,
        ledgerBackup: createMigrationLedgerBackupV1(db, sourceAuthority),
      });
      const section = await sourceBackup.export();
      const sourceBefore = await sourceBackup.inspect();
      const validation = await validateDiamondBackupSectionV1(section);
      assert.deepEqual(
        { valid: validation.valid, quads: validation.quadCount },
        { valid: true, quads: 1 },
      );
      assert.deepEqual(await sourceBackup.inspect(), sourceBefore);
      await assert.rejects(
        validateDiamondBackupSectionV1({
          ...section,
          sha256: '0'.repeat(64),
        }),
        /payload checksum/,
      );

      const target = new NodeSqliteDatabase(':memory:');
      await initializeStore(target);
      await target.batch([
        target.prepare(
          'UPDATE _gnolith_migrations SET applied_at = ? WHERE namespace = ?'
        ).bind('2030-01-01T00:00:00.000Z', diamondMigrationNamespace),
      ]);
      const targetAuthority = createMigrationAssemblyAuthorityV1(
        target, 'packed-coordinate'
      );
      const targetOwner = await registerMigrationLedgerOwnerV1({
        db: target,
        installationId: 'packed-coordinate',
        namespace: diamondMigrationNamespace,
        migrations: diamondMigrations,
        assemblyAuthority: targetAuthority,
      });
      const targetBackup = createDiamondBackupV1({
        db: target,
        owner: targetOwner,
        ledgerBackup: createMigrationLedgerBackupV1(target, targetAuthority),
      });
      await targetBackup.dryRunImport(section, { mode: 'migration-bound' });
      await targetBackup.import(section, { mode: 'migration-bound' });
      await assert.rejects(
        targetBackup.import(section, { mode: 'migration-bound' }),
        /requires empty Diamond tables/,
      );
      await target.close();
      await db.close();
    `,
  );
  execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  const installed = JSON.parse(
    readFileSync(
      join(root, 'node_modules', '@gnolith', 'diamond', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(installed.version, '0.5.0');
  console.log(
    `consumer smoke passed for ${installed.name}@${installed.version}`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
