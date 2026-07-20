import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('consumer smoke must be run through npm');
}
const root = mkdtempSync(join(tmpdir(), 'diamond-consumer-'));
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'));
const packagePath = join(...sourcePackage.name.split('/'));
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
    } from '@gnolith/diamond';
    import { createSparqlHandler } from '@gnolith/diamond/endpoint';
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
  readFileSync(join(root, 'node_modules', packagePath, 'package.json'), 'utf8'),
);
if (
  installed.private !== sourcePackage.private ||
  installed.version !== sourcePackage.version
) {
  throw new Error('Packed metadata differs from the source package');
}
for (const path of [
  'scripts/deployed-e2e.mjs',
  'scripts/deployed-schema-check.mjs',
  'SECURITY.md',
]) {
  if (!existsSync(join(root, 'node_modules', packagePath, path))) {
    throw new Error(`Packed artifact is missing ${path}`);
  }
}
console.log(`consumer smoke passed for ${installed.name}@${installed.version}`);
