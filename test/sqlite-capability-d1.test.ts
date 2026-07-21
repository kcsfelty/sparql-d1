import { Miniflare } from 'miniflare';
import { describe } from 'vitest';
import type { SqliteDatabaseLike } from '../src/d1-types.js';
import { sqliteCapabilityConformance } from './sqlite-capability-conformance.js';

let databaseSequence = 0;

describe('workerd D1 capability conformance', () => {
  sqliteCapabilityConformance({
    blobRowShape: 'byte-array',
    async createHarness() {
      databaseSequence += 1;
      const miniflare = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-07-19',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: `diamond-capability-d1-${databaseSequence}` },
      });
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as SqliteDatabaseLike;
      return {
        claimers: [db, db, db, db],
        db,
        async close() {
          await miniflare.dispose();
        },
      };
    },
  });
});
