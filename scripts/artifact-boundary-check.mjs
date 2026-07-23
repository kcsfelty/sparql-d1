import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('artifact boundary check must run through npm');
const [{ files }] = JSON.parse(
  execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    encoding: 'utf8',
  }),
);
const paths = files.map(({ path }) => path);
for (const required of [
  'dist/index.js',
  'dist/sparql.js',
  'dist/backup.js',
  'dist/node-sqlite.js',
]) {
  assert.ok(paths.includes(required), `packed artifact is missing ${required}`);
}
assert.ok(
  paths.every((path) => !/(?:^|\/)endpoint(?:\.|\/)/iu.test(path)),
  'packed artifact contains the removed endpoint entry',
);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
assert.deepEqual(Object.keys(packageJson.exports).sort(), [
  '.',
  './backup',
  './node-sqlite',
  './sparql',
]);
for (const path of paths.filter((path) => /^dist\/.*\.d?js$/u.test(path))) {
  const content = readFileSync(path, 'utf8');
  assert.doesNotMatch(
    content,
    /createSparqlHandler|SparqlHandlerOptions|authenticate\s*\?|rateLimit\s*\?|cors/iu,
    `${path} exposes a removed network/authentication surface`,
  );
}
console.log(`artifact boundary validated across ${paths.length} packed files`);
