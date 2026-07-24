import { afterEach, describe, expect, it } from 'vitest';
import { DataFactory } from 'rdf-data-factory';
import {
  insertQuads,
  prepareQuadPatch,
  statementsForQuadPatch,
} from '../src/d1-source.js';
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
import {
  adoptDiamond041LegacyOwnerV1,
  createDiamondBackupV1,
  decodeDiamond041LegacyOwnerV1,
  validateDiamondBackupSectionV1,
} from '../src/backup.js';
import type { DiamondBackupSection } from '../src/backup.js';
import { MemoryD1 } from './memory-d1.js';

const databases: MemoryD1[] = [];
const factory = new DataFactory();
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

  it('validates archives without a database and restores a compatible fresh target', async () => {
    const source = memory();
    await initializeStore(source);
    await source.batch([
      source
        .prepare(
          `UPDATE _gnolith_migrations SET applied_at = ?
           WHERE namespace = ?`,
        )
        .bind('2020-01-01T00:00:00.000Z', diamondMigrationNamespace),
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
        .bind('validation-guard'),
    ]);
    const sourceRegistration = await registerDiamond(source, 'same-coordinate');
    const sourceBackup = createDiamondBackupV1({
      db: source,
      owner: sourceRegistration.owner,
      ledgerBackup: sourceRegistration.ledger,
    });
    const section = await sourceBackup.export();
    const before = await sourceBackup.inspect();

    await expect(
      validateDiamondBackupSectionV1(section),
    ).resolves.toMatchObject({
      valid: true,
      quadCount: 1,
      guardCount: 1,
      payloadBytes: section.payload.byteLength,
      sha256: section.sha256,
    });
    await expect(sourceBackup.inspect()).resolves.toEqual(before);
    await expect(
      validateDiamondBackupSectionV1({
        ...section,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/payload checksum/u);
    await expect(
      validateDiamondBackupSectionV1({
        ...section,
        ledger: {
          ...section.ledger,
          canonicalSha256: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow(/ledger checksum/u);

    const target = memory();
    await initializeStore(target);
    await target.batch([
      target
        .prepare(
          `UPDATE _gnolith_migrations SET applied_at = ?
           WHERE namespace = ?`,
        )
        .bind('2021-01-01T00:00:00.000Z', diamondMigrationNamespace),
    ]);
    const targetRegistration = await registerDiamond(target, 'same-coordinate');
    const targetBackup = createDiamondBackupV1({
      db: target,
      owner: targetRegistration.owner,
      ledgerBackup: targetRegistration.ledger,
    });
    await expect(
      targetBackup.dryRunImport(section, { mode: 'migration-bound' }),
    ).resolves.toMatchObject({ dryRun: true, quadCount: 1, guardCount: 1 });
    await expect(
      targetBackup.import(section, { mode: 'migration-bound' }),
    ).resolves.toMatchObject({ dryRun: false, quadCount: 1, guardCount: 1 });
    await expect(
      targetBackup.import(section, { mode: 'migration-bound' }),
    ).rejects.toThrow(/requires empty Diamond tables/u);

    const mismatch = memory();
    await initializeStore(mismatch);
    const mismatchRegistration = await registerDiamond(
      mismatch,
      'same-coordinate',
    );
    const mismatchBackup = createDiamondBackupV1({
      db: mismatch,
      owner: mismatchRegistration.owner,
      ledgerBackup: mismatchRegistration.ledger,
    });
    await mismatch.batch([
      mismatch
        .prepare(
          `UPDATE _gnolith_migrations SET checksum = ?
           WHERE namespace = ? AND migration_id = ?`,
        )
        .bind(
          '0'.repeat(64),
          diamondMigrationNamespace,
          diamondMigrations[0]!.id,
        ),
    ]);
    await expect(
      mismatchBackup.dryRunImport(section, { mode: 'migration-bound' }),
    ).rejects.toThrow(/Checksum drift.*0001/u);
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

  it('decodes exact 0.4.1 state read-only into a bounded adoptable fragment', async () => {
    const source = memory();
    await initializeStore(source);
    await insertQuads(source, [
      factory.quad(
        factory.namedNode('https://example.test/legacy'),
        factory.namedNode('https://example.test/value'),
        factory.literal('preserve'),
      ),
    ]);
    const observedSql: string[] = [];
    const readOnlySource = {
      prepare(sql: string) {
        observedSql.push(sql);
        return source.prepare(sql);
      },
    };
    const fragment = await decodeDiamond041LegacyOwnerV1({
      source: readOnlySource,
      attestation: {
        packageName: '@gnolith/diamond',
        packageVersion: '0.4.1',
      },
    });
    expect(fragment).toMatchObject({
      format: 'diamond-legacy-owner-fragment-v1',
      source: {
        packageName: '@gnolith/diamond',
        packageVersion: '0.4.1',
      },
      counts: { quads: 1, patchGuards: 0 },
      ledger: { namespace: diamondMigrationNamespace },
    });
    expect(fragment.digests.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(fragment)).toBe(true);
    expect(
      observedSql.every(
        (sql) =>
          /^\s*(?:SELECT|PRAGMA)\b/iu.test(sql) &&
          !/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/iu.test(sql),
      ),
    ).toBe(true);

    const target = memory();
    const registration = await registerDiamond(target, 'adopt-target');
    const backup = createDiamondBackupV1({
      db: target,
      owner: registration.owner,
      ledgerBackup: registration.ledger,
    });
    await expect(
      backup.import(adoptDiamond041LegacyOwnerV1(fragment), {
        mode: 'empty',
      }),
    ).resolves.toMatchObject({ quadCount: 1 });
    await expect(
      target.prepare('SELECT COUNT(*) AS count FROM rdf_quads').all(),
    ).resolves.toMatchObject({ results: [{ count: 1 }] });
    expect(() => adoptDiamond041LegacyOwnerV1({ ...fragment })).toThrow(
      /forged|serialized/u,
    );
  });

  it('rejects unattested, oversized, or schema-drifted 0.4.1 sources', async () => {
    const source = memory();
    await initializeStore(source);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.0',
        } as never,
      }),
    ).rejects.toThrow(/exact @gnolith\/diamond@0\.4\.1/u);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/not-diamond',
          packageVersion: '0.4.1',
        } as never,
      }),
    ).rejects.toThrow(/exact @gnolith\/diamond@0\.4\.1/u);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxQuads: 0 },
      }),
    ).rejects.toThrow(/maxQuads/u);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxPayloadBytes: 64 * 1024 * 1024 + 1 },
      }),
    ).rejects.toThrow(/maxPayloadBytes/u);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxPayloadBytes: 0 },
      }),
    ).rejects.toThrow(/maxPayloadBytes/u);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxQuads: 1_000_001 },
      }),
    ).rejects.toThrow(/maxQuads/u);
    await source.batch([
      source
        .prepare('INSERT INTO rdf_patch_guards (patch_id) VALUES (?)')
        .bind('one'),
      source
        .prepare('INSERT INTO rdf_patch_guards (patch_id) VALUES (?)')
        .bind('two'),
    ]);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxQuads: 1 },
      }),
    ).rejects.toThrow(/contains 2 patch guards/u);
    await source.batch([source.prepare('DELETE FROM rdf_patch_guards')]);
    await insertQuads(source, [
      factory.quad(
        factory.namedNode('https://example.test/a'),
        factory.namedNode('https://example.test/p'),
        factory.literal('v'),
      ),
    ]);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxQuads: 1, maxPayloadBytes: 1 },
      }),
    ).rejects.toThrow(/payload is .* configured maximum/u);
    const changingSource = {
      prepare(sql: string) {
        if (/FROM rdf_quads ORDER BY id/u.test(sql)) {
          const statement = {
            bind() {
              return statement;
            },
            async all() {
              return { results: [] };
            },
          };
          return statement;
        }
        return source.prepare(sql);
      },
    };
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source: changingSource,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
      }),
    ).rejects.toThrow(/changed while/u);
    await insertQuads(source, [
      factory.quad(
        factory.namedNode('https://example.test/b'),
        factory.namedNode('https://example.test/p'),
        factory.literal('v'),
      ),
    ]);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
        limits: { maxQuads: 1 },
      }),
    ).rejects.toThrow(/contains 2 quads/u);
    const ledgerRow = await source
      .prepare('SELECT checksum FROM _gnolith_migrations WHERE namespace = ?')
      .bind(diamondMigrationNamespace)
      .all<{ checksum: string }>();
    await source.batch([
      source
        .prepare(
          'UPDATE _gnolith_migrations SET checksum = ? WHERE namespace = ?',
        )
        .bind('0'.repeat(64), diamondMigrationNamespace),
    ]);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
      }),
    ).rejects.toThrow(/namespace-ledger evidence/u);
    await source.batch([
      source
        .prepare(
          'UPDATE _gnolith_migrations SET checksum = ? WHERE namespace = ?',
        )
        .bind(ledgerRow.results[0]!.checksum, diamondMigrationNamespace),
    ]);
    await source.batch([
      source.prepare('DROP INDEX rdf_quads_pogs_idx'),
      source.prepare('CREATE INDEX rdf_quads_pogs_idx ON rdf_quads(id)'),
    ]);
    await expect(
      decodeDiamond041LegacyOwnerV1({
        source,
        attestation: {
          packageName: '@gnolith/diamond',
          packageVersion: '0.4.1',
        },
      }),
    ).rejects.toThrow(/exact Diamond 0\.4\.1/u);
  });
});
