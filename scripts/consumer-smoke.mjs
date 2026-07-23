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
      import {
        initializeStore,
        prepareQuadPatch,
        statementsForQuadPatch,
      } from '@gnolith/diamond';
      import { createSparqlExecutor } from '@gnolith/diamond/sparql';
      import {
        adoptDiamond041LegacyOwnerV1,
        createDiamondBackupV1,
        decodeDiamond041LegacyOwnerV1,
      } from '@gnolith/diamond/backup';
      import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
      if ([initializeStore, prepareQuadPatch, statementsForQuadPatch,
        createSparqlExecutor, createDiamondBackupV1,
        decodeDiamond041LegacyOwnerV1, adoptDiamond041LegacyOwnerV1,
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
