import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import { NodeSqliteDatabase } from '../src/node-sqlite.js';
import { sqliteCapabilityConformance } from './sqlite-capability-conformance.js';

describe('Node SQLite capability conformance', () => {
  sqliteCapabilityConformance({
    blobRowShape: 'typed-array',
    largeIntegerBehavior: 'preserve-bigint',
    async createHarness() {
      const directory = await mkdtemp(
        join(tmpdir(), 'diamond-capability-node-'),
      );
      const path = join(directory, 'database.sqlite');
      const claimers = [
        new NodeSqliteDatabase(path),
        new NodeSqliteDatabase(path),
        new NodeSqliteDatabase(path),
        new NodeSqliteDatabase(path),
      ];
      return {
        claimers,
        db: claimers[0]!,
        async reopen() {
          await Promise.all(claimers.map((db) => db.close()));
          const reopened = new NodeSqliteDatabase(path);
          claimers.push(reopened);
          return reopened;
        },
        async close() {
          await Promise.all(claimers.map((db) => db.close()));
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  });
});
