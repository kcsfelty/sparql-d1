import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import type { SqliteDatabaseLike } from '../src/d1-types.js';
import { sqliteCapabilityConformance } from './sqlite-capability-conformance.js';

let databaseSequence = 0;

describe('workerd D1 capability conformance', () => {
  sqliteCapabilityConformance({
    blobRowShape: 'byte-array',
    largeIntegerBehavior: 'reject-bigint',
    async createHarness() {
      databaseSequence += 1;
      const directory = await mkdtemp(join(tmpdir(), 'diamond-capability-d1-'));
      const databaseName = `diamond-capability-d1-${databaseSequence}`;
      const createMiniflare = () =>
        new Miniflare({
          modules: true,
          script: 'export default { fetch() { return new Response("ok") } }',
          compatibilityDate: '2026-07-19',
          compatibilityFlags: ['nodejs_compat'],
          d1Persist: directory,
          d1Databases: { DB: databaseName },
        });
      let miniflare = createMiniflare();
      const getDb = async () =>
        (await miniflare.getD1Database('DB')) as unknown as SqliteDatabaseLike;
      const db = await getDb();
      return {
        claimers: [db, db, db, db],
        db,
        async reopen() {
          await miniflare.dispose();
          miniflare = createMiniflare();
          return getDb();
        },
        async close() {
          await miniflare.dispose();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  });
});
