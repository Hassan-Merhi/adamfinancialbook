import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sourceUrl = process.env.TEST_DATABASE_URL;
const backupKey = 'phase9-ci-backup-key-that-is-definitely-longer-than-thirty-two-characters';
let admin: pg.Client | null = null;
let targetUrl = '';
let targetDatabase = '';
let temp = '';

describe.skipIf(!sourceUrl)('Phase 9 backup and recovery drill', () => {
  beforeAll(async () => {
    process.env.BACKUP_ENCRYPTION_KEY = backupKey;
    const source = new URL(sourceUrl!);
    targetDatabase = `book_restore_${randomBytes(6).toString('hex')}`;
    const adminUrl = new URL(source.toString());
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: false });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${targetDatabase}"`);
    const target = new URL(source.toString());
    target.pathname = `/${targetDatabase}`;
    targetUrl = target.toString();
    temp = mkdtempSync(join(tmpdir(), 'book-recovery-'));
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [targetDatabase],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${targetDatabase}"`).catch(() => undefined);
      await admin.end();
    }
    if (temp) rmSync(temp, { recursive: true, force: true });
    delete process.env.BACKUP_ENCRYPTION_KEY;
  });

  it('creates an authenticated encrypted snapshot and restores it into a clean database', async () => {
    const [{ createEncryptedDatabaseBackup, decryptBackupBuffer }, { pool }] = await Promise.all([
      import('./backup-service.js'),
      import('./db.js'),
    ]);
    const artifact = await createEncryptedDatabaseBackup('ci-restore-drill');
    expect(artifact.buffer.subarray(0, 4).toString('utf8')).toBe('AFB9');
    expect(artifact.bytes).toBeGreaterThan(64);
    expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/);

    const snapshot = decryptBackupBuffer(artifact.buffer);
    expect(snapshot.tables.length).toBeGreaterThan(5);
    expect(snapshot.migrationVersion).toBe(7);
    const file = join(temp, artifact.filename);
    writeFileSync(file, artifact.buffer);

    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const output = execFileSync(npx, ['tsx', 'server/restore.ts', file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: sourceUrl!,
        RESTORE_DATABASE_URL: targetUrl,
        BACKUP_ENCRYPTION_KEY: backupKey,
        PGSSL: 'off',
        NODE_ENV: 'test',
      },
    });
    expect(output).toContain('restore.verified');

    const target = new pg.Client({ connectionString: targetUrl, ssl: false });
    await target.connect();
    try {
      for (const table of snapshot.tables) {
        const count = await target.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table.name.replace(/"/g, '""')}"`,
        );
        expect(Number(count.rows[0]?.n ?? -1), table.name).toBe(table.rowCount);
      }
      const migration = await target.query<{ version: string | number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(Number(migration.rows[0]?.version)).toBe(7);
    } finally {
      await target.end();
      // Leave the source pool open for any later integration files in this run.
      expect(pool.totalCount).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('rejects a modified encrypted backup', async () => {
    const { createEncryptedDatabaseBackup, decryptBackupBuffer } = await import('./backup-service.js');
    const artifact = await createEncryptedDatabaseBackup('ci-tamper-test');
    const modified = Buffer.from(artifact.buffer);
    modified[modified.length - 1] ^= 0xff;
    expect(() => decryptBackupBuffer(modified)).toThrow(/authentication failed/i);
  });
});
