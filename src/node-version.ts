/** Internal release-line guard for APIs used by the Node SQLite adapter. */
export function assertSupportedNodeSqliteVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) {
    throw unsupported(version);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported =
    (major === 22 && minor >= 16) ||
    (major === 23 && minor >= 11) ||
    major >= 24;
  if (!supported) {
    throw unsupported(version);
  }
}

function unsupported(version: string): Error {
  return new Error(
    `@gnolith/diamond/node-sqlite does not support Node.js ${version}; use >=22.16 on Node 22, >=23.11 on Node 23, or >=24`,
  );
}
