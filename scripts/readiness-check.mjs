import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'MAINTAINERS.md',
  'ROADMAP.md',
  'SECURITY.md',
  'SUPPORT.md',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/security.yml',
  '.github/workflows/release.yml',
  'docs/api.md',
  'docs/architecture.md',
  'docs/completion-audit.md',
  'docs/conformance.md',
  'docs/integration-validation.md',
  'docs/open-source-readiness.md',
  'docs/performance.md',
  'docs/sql-pushdown-decision.md',
  'docs/storage-evaluation.md',
  'docs/testing.md',
  'docs/threat-model.md',
  'examples/wikibase-style-statements.md',
  'examples/wikibase-style-statements.ts',
  'migrations/0001_rdf_quads.sql',
  'migrations/0002_drop_redundant_spog.sql',
  'scripts/wikibase-example-check.ts',
];

const repositoryFiles = execFileSync('git', [
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
])
  .toString('utf8')
  .split('\0')
  .filter((file) => file.length > 0 && existsSync(file));
const repositoryFileSet = new Set(repositoryFiles);
for (const file of requiredFiles) {
  assert.ok(
    repositoryFileSet.has(file),
    `required readiness file is missing: ${file}`,
  );
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(packageJson.license, 'MIT');
assert.equal(packageJson.publishConfig?.access, 'public');
assert.equal(packageJson.publishConfig?.provenance, true);
assert.equal(packageJson.private, false);
assert.match(packageJson.engines?.node ?? '', /^>=22/);
assert.equal(
  packageJson.repository?.url,
  'https://github.com/gnolith/diamond.git',
);

for (const file of [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/integration-validation.md',
  'docs/open-source-readiness.md',
]) {
  const text = readFileSync(file, 'utf8');
  for (const stale of [
    'repository remains private',
    'package is not published',
    'packed private artifact',
    'private during its initial development',
    'No public version is supported',
  ]) {
    assert.ok(!text.includes(stale), `${file} contains stale text: ${stale}`);
  }
}

const visibleMarkdown = (file) => {
  const markdown = readFileSync(file, 'utf8');
  const visible = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const commentStart = markdown.indexOf('<!--', cursor);
    if (commentStart === -1) {
      visible.push(markdown.slice(cursor));
      break;
    }

    visible.push(markdown.slice(cursor, commentStart));
    const commentEnd = markdown.indexOf('-->', commentStart + 4);
    if (commentEnd === -1) break;
    cursor = commentEnd + 3;
  }

  return visible.join(' ').replace(/\s+/gu, ' ');
};
for (const [file, requirement] of [
  [
    'README.md',
    "Diamond's published Worker entry points require the Cloudflare Workers `nodejs_compat` compatibility flag.",
  ],
  [
    'docs/api.md',
    'Workers runtime configured with the `nodejs_compat` compatibility flag.',
  ],
  [
    'docs/integration-validation.md',
    'Worker consumers must enable the `nodejs_compat` compatibility flag.',
  ],
]) {
  const text = visibleMarkdown(file);
  assert.ok(
    text.includes(requirement),
    `${file} must state the positive Worker runtime requirement`,
  );
  assert.doesNotMatch(
    text,
    /(?:does not|do not|without) require `nodejs_compat`|`nodejs_compat` is optional/iu,
    `${file} contradicts the Worker runtime requirement`,
  );
}
const workerConfig = JSON.parse(
  readFileSync('wrangler.jsonc', 'utf8')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/,\s*([}\]])/gu, '$1'),
);
assert.deepEqual(
  workerConfig.compatibility_flags,
  ['nodejs_compat'],
  'Worker bundle fixture must declare exactly the supported compatibility flags',
);

for (const workflow of repositoryFiles.filter((file) =>
  file.startsWith('.github/workflows/'),
)) {
  const text = readFileSync(workflow, 'utf8');
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const reference = match[1];
    assert.match(
      reference,
      /@[0-9a-f]{40}$/,
      `${workflow} action is not pinned to a full commit: ${reference}`,
    );
  }
}

const prohibitedPath =
  /(?:[A-Za-z]:\\Users\\[^\s"']+|\/Users\/[^\s"']+|\/home\/[^\s"']+)/;
for (const file of repositoryFiles.filter(
  (path) =>
    !path.endsWith('package-lock.json') &&
    !path.endsWith('.tgz') &&
    !path.match(/\.(?:png|jpe?g|gif|webp|ico|pdf)$/i),
)) {
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(
    text,
    prohibitedPath,
    `${file} contains a local user path`,
  );
}

const release = readFileSync('.github/workflows/release.yml', 'utf8');
for (const required of [
  'npm run release:check',
  'npm sbom',
  'sha256sum',
  'actions/attest-build-provenance@',
  'npm publish ./*.tgz --access public --provenance',
  'github.event.repository.private == false',
]) {
  assert.ok(
    release.includes(required),
    `release workflow is missing: ${required}`,
  );
}

console.log(
  `open-source structure validated: ${requiredFiles.length} required files, ` +
    `${repositoryFiles.length} repository files, pinned Actions, clean local paths`,
);
