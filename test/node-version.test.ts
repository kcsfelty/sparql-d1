import { describe, expect, it } from 'vitest';
import { assertSupportedNodeSqliteVersion } from '../src/node-version.js';

describe('node:sqlite runtime guard', () => {
  it.each(['22.16.0', '22.99.1', '23.11.0', '23.99.0', '24.0.0', '25.1.2'])(
    'accepts supported release line %s',
    (version) => {
      expect(() => assertSupportedNodeSqliteVersion(version)).not.toThrow();
    },
  );

  it.each(['21.99.0', '22.15.99', '23.10.99', 'not-a-version'])(
    'rejects release without required statement metadata API: %s',
    (version) => {
      expect(() => assertSupportedNodeSqliteVersion(version)).toThrow(
        /does not support Node\.js/u,
      );
    },
  );
});
