import { afterEach, describe, expect, it } from 'vitest';
import { prepareQuadPatch, statementsForQuadPatch } from '../src/d1-source.js';
import {
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  registerMigrationLedgerOwnerV1,
  type MigrationLedgerOwnerHandle,
} from '../src/migrations.js';
import {
  diamondMigrationNamespace,
  diamondMigrations,
  initializeStore,
} from '../src/schema.js';
import { createDiamondBackupV1 } from '../src/backup.js';
import type { DiamondBackupSection } from '../src/backup.js';
import { MemoryD1 } from './memory-d1.js';

const databases: MemoryD1[] = [];
const memory = () => {
  const db = new MemoryD1();
  databases.push(db);
  return db;
};

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

async function registerDiamond(db: MemoryD1, installationId: string) {
  const authority = createMigrationAssemblyAuthorityV1(db, installationId);
  const owner = await registerMigrationLedgerOwnerV1({
    db,
    installationId,
    namespace: diamondMigrationNamespace,
    migrations: diamondMigrations,
    assemblyAuthority: authority,
  });
  return {
    authority,
    owner,
    ledger: createMigrationLedgerBackupV1(db, authority),
  };
}

async function sha256(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('architecture reset ownership boundaries', () => {
  it('binds prepared plans to their exact connection and rejects forged plans', () => {
    const first = memory();
    const second = memory();
    const plan = prepareQuadPatch(first, {});
    expect(statementsForQuadPatch(first, plan)).toEqual([]);
    expect(() => statementsForQuadPatch(second, plan)).toThrow(
      /another SQL connection/u,
    );
    expect(() =>
      statementsForQuadPatch(first, {
        statements: [],
        mapError: (cause) => cause as Error,
        readResult: () => ({ deleted: 0, inserted: 0 }),
      }),
    ).toThrow(/forged/u);
  });

  it('exports canonical namespace evidence and rejects duplicate or forged owners', async () => {
    const db = memory();
    await initializeStore(db);
    const registration = await registerDiamond(db, 'workshop-a');
    const slice = await registration.ledger.exportNamespace(registration.owner);
    expect(slice).toMatchObject({
      format: 'diamond-migration-ledger-slice-v1',
      namespace: diamondMigrationNamespace,
    });
    expect(slice.entries).toHaveLength(diamondMigrations.length);
    expect(slice.canonicalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(registration.owner)).toBe(true);
    await expect(
      registerMigrationLedgerOwnerV1({
        db,
        installationId: 'workshop-a',
        namespace: diamondMigrationNamespace,
        migrations: diamondMigrations,
        assemblyAuthority: registration.authority,
      }),
    ).rejects.toThrow(/already has an owner/u);
    await expect(
      registration.ledger.exportNamespace({
        ...registration.owner,
      } as MigrationLedgerOwnerHandle),
    ).rejects.toThrow(/forged|serialized/u);
    await expect(
      registration.ledger.verifyNamespace(registration.owner, {
        ...slice,
        canonicalSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/digest mismatch/u);
    await expect(
      registration.ledger.restoreNamespace(registration.owner, slice, {
        mode: 'empty',
      }),
    ).rejects.toThrow(/non-empty ledger/u);
  });

  it('round-trips only Diamond data and leaves foreign tables untouched', async () => {
    const source = memory();
    await initializeStore(source);
    await source.batch([
      source
        .prepare(
          `INSERT INTO rdf_quads
           (subject_key, subject_json, predicate_key, predicate_json,
            object_key, object_json, graph_key, graph_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('s', '"s"', 'p', '"p"', 'o', '"o"', 'g', '"g"'),
      source
        .prepare('INSERT INTO rdf_patch_guards (patch_id) VALUES (?)')
        .bind('backup-guard'),
    ]);
    const sourceRegistration = await registerDiamond(source, 'source');
    const sourceBackup = createDiamondBackupV1({
      db: source,
      owner: sourceRegistration.owner,
      ledgerBackup: sourceRegistration.ledger,
    });
    const section = await sourceBackup.export();

    const target = memory();
    await target.batch([
      target.prepare(
        'CREATE TABLE foreign_owner (id INTEGER PRIMARY KEY, value TEXT) STRICT',
      ),
      target
        .prepare('INSERT INTO foreign_owner (id, value) VALUES (?, ?)')
        .bind(1, 'preserve'),
    ]);
    const targetRegistration = await registerDiamond(target, 'target');
    const targetBackup = createDiamondBackupV1({
      db: target,
      owner: targetRegistration.owner,
      ledgerBackup: targetRegistration.ledger,
    });
    await expect(
      targetBackup.dryRunImport(section, { mode: 'empty' }),
    ).resolves.toMatchObject({ dryRun: true, action: 'import', quadCount: 1 });
    await expect(
      targetBackup.import(section, { mode: 'empty' }),
    ).resolves.toMatchObject({ dryRun: false, quadCount: 1 });
    await expect(
      target
        .prepare('SELECT value FROM foreign_owner WHERE id = 1')
        .all<{ value: string }>(),
    ).resolves.toMatchObject({ results: [{ value: 'preserve' }] });
    await expect(
      target.prepare('SELECT COUNT(*) AS count FROM rdf_quads').all(),
    ).resolves.toMatchObject({ results: [{ count: 1 }] });
    await expect(
      target.prepare('SELECT patch_id FROM rdf_patch_guards').all(),
    ).resolves.toMatchObject({ results: [{ patch_id: 'backup-guard' }] });
  });

  it('rejects checksum corruption before import and reports explicit rebuilds', async () => {
    const db = memory();
    await initializeStore(db);
    const registration = await registerDiamond(db, 'source');
    const backup = createDiamondBackupV1({
      db,
      owner: registration.owner,
      ledgerBackup: registration.ledger,
    });
    const section = await backup.export();
    await expect(
      backup.dryRunImport(
        { ...section, sha256: '0'.repeat(64) },
        { mode: 'migration-bound' },
      ),
    ).rejects.toThrow(/checksum/u);
    await expect(
      backup.dryRunImport(section, { mode: 'rebuild' }),
    ).resolves.toMatchObject({
      action: 'rebuild-required',
      message: expect.stringContaining('not imported or discarded'),
    });
    await expect(
      backup.dryRunImport(
        { ...section, owner: 'other' as never },
        { mode: 'rebuild' },
      ),
    ).rejects.toThrow(/Unsupported Diamond backup/u);
    await expect(
      backup.dryRunImport(section, { mode: 'migration-bound' }),
    ).resolves.toMatchObject({ action: 'import', dryRun: true });
    await expect(
      backup.import(section, { mode: 'migration-bound' }),
    ).resolves.toMatchObject({ action: 'import', dryRun: false });
    await expect(backup.import(section, { mode: 'empty' })).rejects.toThrow(
      /Diamond tables to be absent/u,
    );
    await db.batch([
      db
        .prepare('INSERT INTO rdf_patch_guards (patch_id) VALUES (?)')
        .bind('occupied'),
    ]);
    await expect(
      backup.import(section, { mode: 'migration-bound' }),
    ).rejects.toThrow(/empty Diamond tables/u);
  });

  it('rejects wrong owners, authorities, and invalid backup targets', async () => {
    const db = memory();
    const authority = createMigrationAssemblyAuthorityV1(db, 'install');
    await expect(
      registerMigrationLedgerOwnerV1({
        db,
        installationId: 'other',
        namespace: diamondMigrationNamespace,
        migrations: diamondMigrations,
        assemblyAuthority: authority,
      }),
    ).rejects.toThrow(/another connection or installation/u);
    expect(() => createMigrationLedgerBackupV1(memory(), authority)).toThrow(
      /another connection/u,
    );
    const owner = await registerMigrationLedgerOwnerV1({
      db,
      installationId: 'install',
      namespace: diamondMigrationNamespace,
      migrations: diamondMigrations,
      assemblyAuthority: authority,
    });
    const ledger = createMigrationLedgerBackupV1(db, authority);
    const backup = createDiamondBackupV1({ db, owner, ledgerBackup: ledger });
    await expect(backup.export()).rejects.toThrow(/exact live schema/u);
    expect(() =>
      createDiamondBackupV1({
        db,
        owner: { ...owner, namespace: '@gnolith/not-diamond' },
        ledgerBackup: ledger,
      }),
    ).toThrow(/Diamond migration owner/u);
  });

  it('rolls back empty-target schema and ledger when payload insertion fails', async () => {
    const source = memory();
    await initializeStore(source);
    const sourceRegistration = await registerDiamond(source, 'source');
    const ledger = await sourceRegistration.ledger.exportNamespace(
      sourceRegistration.owner,
    );
    const row = {
      graph_json: '"g"',
      graph_key: 'g',
      id: 1,
      object_json: '"o"',
      object_key: 'o',
      predicate_json: '"p"',
      predicate_key: 'p',
      subject_json: '"s"',
      subject_key: 's',
    };
    const payload = new TextEncoder().encode(
      JSON.stringify({
        format: 'diamond-backup-payload-v1',
        guards: [],
        quads: [row, { ...row, id: 2 }],
      }),
    );
    const section: DiamondBackupSection = {
      owner: 'diamond',
      formatVersion: 1,
      schemaVersion: 1,
      ledger,
      payload,
      sha256: await sha256(payload),
    };
    const target = memory();
    const targetRegistration = await registerDiamond(target, 'target');
    const backup = createDiamondBackupV1({
      db: target,
      owner: targetRegistration.owner,
      ledgerBackup: targetRegistration.ledger,
    });
    await expect(backup.import(section, { mode: 'empty' })).rejects.toThrow();
    await expect(
      target
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name IN ('rdf_quads', 'rdf_patch_guards')`,
        )
        .all(),
    ).resolves.toMatchObject({ results: [] });
    await expect(
      target
        .prepare(
          'SELECT COUNT(*) AS count FROM _gnolith_migrations WHERE namespace = ?',
        )
        .bind(diamondMigrationNamespace)
        .all(),
    ).resolves.toMatchObject({ results: [{ count: 0 }] });
  });
});
