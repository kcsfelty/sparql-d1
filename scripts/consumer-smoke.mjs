import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('consumer smoke must be run through npm');
}
const root = mkdtempSync(join(tmpdir(), 'sparql-d1-consumer-'));
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'));
const packOutput = execFileSync(
  process.execPath,
  [npmCli, 'pack', '--json', '--pack-destination', root],
  { encoding: 'utf8' },
);
const [{ filename }] = JSON.parse(packOutput);
const archive = join(root, filename);

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
    archive,
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import {
      D1QuadSource,
      allowServiceUrls,
      initializeStore,
    } from 'sparql-d1';
    import { createSparqlHandler } from 'sparql-d1/endpoint';
    if (
      typeof D1QuadSource !== 'function' ||
      typeof allowServiceUrls !== 'function' ||
      typeof initializeStore !== 'function' ||
      typeof createSparqlHandler !== 'function'
    ) {
      throw new Error('Expected package exports are unavailable');
    }
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

const installed = JSON.parse(
  readFileSync(join(root, 'node_modules', 'sparql-d1', 'package.json'), 'utf8'),
);
if (
  installed.private !== sourcePackage.private ||
  installed.version !== sourcePackage.version
) {
  throw new Error('Packed metadata differs from the source package');
}
console.log(`consumer smoke passed for ${installed.name}@${installed.version}`);
