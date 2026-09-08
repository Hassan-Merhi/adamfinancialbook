import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sourceUrl = process.env.TEST_DATABASE_URL;
const backupKey = 'phase4-dr-boot-key-that-is-definitely-longer-than-thirty-two-characters';
const port = 43198;
let admin: pg.Client | null = null;
let targetDatabase = '';
let targetUrl = '';
let temp = '';
let backupFile = '';
let server: ChildProcess | null = null;
let serverLog = '';

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function waitForReady(): Promise<any> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server && server.exitCode !== null) throw new Error(`Restored server exited early:\n${serverLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      if (response.ok) return response.json();
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Restored database never became ready:\n${serverLog}`);
}

describe.skipIf(!sourceUrl)('Phase 4 restored database boot certification', () => {
  beforeAll(async () => {
    process.env.BACKUP_ENCRYPTION_KEY = backupKey;
    const { runMigrations } = await import('./migration.js');
    await runMigrations();

    const source = new URL(sourceUrl!);
    targetDatabase = `book_dr_boot_${randomBytes(6).toString('hex')}`;
    const adminUrl = new URL(source.toString());
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: false });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${targetDatabase}"`);

    const target = new URL(source.toString());
    target.pathname = `/${targetDatabase}`;
    targetUrl = target.toString();

    const { createEncryptedDatabaseBackup } = await import('./backup-service.js');
    const artifact = await createEncryptedDatabaseBackup('phase4-boot-drill');
    temp = mkdtempSync(join(tmpdir(), 'book-dr-boot-'));
    backupFile = join(temp, artifact.filename);
    writeFileSync(backupFile, artifact.buffer);
  }, 30_000);

  afterAll(async () => {
    await stopServer();
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
  }, 15_000);

  it('refuses to overwrite the source database during a normal restore drill', () => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    expect(() => execFileSync(npx, ['tsx', 'server/restore.ts', backupFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: sourceUrl!,
        RESTORE_DATABASE_URL: sourceUrl!,
        BACKUP_ENCRYPTION_KEY: backupKey,
        PGSSL: 'off',
        NODE_ENV: 'test',
        ALLOW_PRODUCTION_RESTORE: '',
      },
    })).toThrow();
  });

  it('restores into a disposable database and boots the production server cleanly', async () => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const output = execFileSync(npx, ['tsx', 'server/restore.ts', backupFile], {
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

    server = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: targetUrl,
        BACKUP_ENCRYPTION_KEY: backupKey,
        SESSION_SECRET: 'phase4-restored-server-session-secret-long-enough',
        PGSSL: 'off',
        NODE_ENV: 'test',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    server.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });

    const ready = await waitForReady();
    expect(ready.ok).toBe(true);
    expect(ready.database).toBe('ok');
    expect(ready.migrations).toBe('current');
    expect(ready.pendingMigrations).toBe(0);

    const client = new pg.Client({ connectionString: targetUrl, ssl: false });
    await client.connect();
    try {
      const status = await client.query<{ current: number }>(
        `SELECT max(version)::int AS current FROM schema_migrations`,
      );
      expect(Number(status.rows[0]?.current)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});
