import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const target = resolve(root, 'dist');
if (
  target === root ||
  !target.endsWith(`${process.platform === 'win32' ? '\\' : '/'}dist`)
) {
  throw new Error(`Refusing to clean unexpected build output path: ${target}`);
}
rmSync(target, { recursive: true, force: true });
