import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sourceUrl = process.env.TEST_DATABASE_URL;
const backupKey = 'phase9-ci-backup-key-that-is-definitely-longer-than-thirty-two-characters';
const evidenceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
let admin: pg.Client | null = null;
let targetUrl = '';
let targetDatabase = '';
let temp = '';
let sourceAuditId = 0;

describe.skipIf(!sourceUrl)('Phase 9 backup and recovery drill', () => {
  beforeAll(async () => {
    process.env.BACKUP_ENCRYPTION_KEY = backupKey;

    // Earlier integration suites deliberately tear public down to test upgrades.
    // Recovery owns its starting state instead of depending on test file order.
    const { runMigrations } = await import('./migration.js');
    await runMigrations();

    const sourceClient = new pg.Client({ connectionString: sourceUrl!, ssl: false });
    await sourceClient.connect();
    try {
      await sourceClient.query(
        `INSERT INTO businesses (id, name) VALUES ('recovery_business','Recovery Business')
         ON CONFLICT (id) DO NOTHING`,
      );
      await sourceClient.query(
        `INSERT INTO accounts (id, name, business_id, opening)
         VALUES ('recovery_account','Recovery Cash','recovery_business',0)
         ON CONFLICT (id) DO NOTHING`,
      );
      await sourceClient.query(
        `INSERT INTO users (id, email, password_hash, role)
         VALUES ('recovery_user','recovery@example.com','not-a-real-login-hash','owner')
         ON CONFLICT (id) DO NOTHING`,
      );
      await sourceClient.query(
        `INSERT INTO approval_requests (id, created_by, account_id, request_text, amount, status)
         VALUES ('recovery_request','recovery_user','recovery_account','Recovery evidence',12.34,'pending')
         ON CONFLICT (id) DO NOTHING`,
      );
      await sourceClient.query(
        `INSERT INTO attachments
           (id, uploaded_by, approval_request_id, filename, mime_type, byte_size, data)
         VALUES ('recovery_attachment','recovery_user','recovery_request','recovery.png','image/png',$1,$2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, byte_size = EXCLUDED.byte_size`,
        [evidenceBytes.length, evidenceBytes],
      );
      const audit = await sourceClient.query<{ id: string | number }>(
        `INSERT INTO audit (actor, actor_email, action, subject, detail)
         VALUES ('recovery_user','recovery@example.com','phase9 restore marker','recovery','{}'::jsonb)
         RETURNING id`,
      );
      sourceAuditId = Number(audit.rows[0].id);
    } finally {
      await sourceClient.end();
    }

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
    const { createEncryptedDatabaseBackup, decryptBackupBuffer } = await import('./backup-service.js');
    const artifact = await createEncryptedDatabaseBackup('ci-restore-drill');
    expect(artifact.buffer.subarray(0, 4).toString('utf8')).toBe('AFB9');
    expect(artifact.bytes).toBeGreaterThan(64);
    expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/);

    const snapshot = decryptBackupBuffer(artifact.buffer);
    expect(snapshot.tables.length).toBeGreaterThan(5);
    expect(snapshot.migrationVersion).toBe(6);
    expect(snapshot.tables.map((table) => table.name)).not.toContain('backup_runs');
    expect(snapshot.tables.map((table) => table.name)).not.toContain('operational_events');
    expect(snapshot.tables.map((table) => table.name)).not.toContain('translation_cache');
    const attachment = snapshot.tables.find((table) => table.name === 'attachments');
    expect(attachment?.binaryColumns).toContain('data');
    expect(attachment?.rows.some((row) => row.id === 'recovery_attachment')).toBe(true);

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
      const binary = await target.query<{ data: Buffer }>(
        `SELECT data FROM attachments WHERE id = 'recovery_attachment'`,
      );
      expect(Buffer.compare(binary.rows[0].data, evidenceBytes)).toBe(0);

      const migration = await target.query<{ version: string | number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(Number(migration.rows[0]?.version)).toBe(6);

      const nextAudit = await target.query<{ id: string | number }>(
        `INSERT INTO audit (actor, action, subject, detail)
         VALUES ('restore-check','post restore sequence','recovery','{}'::jsonb)
         RETURNING id`,
      );
      expect(Number(nextAudit.rows[0].id)).toBeGreaterThan(sourceAuditId);
    } finally {
      await target.end();
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
