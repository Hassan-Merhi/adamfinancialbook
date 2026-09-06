import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Render Phase 4 final production certification contract', () => {
  it('keeps production readiness and external monitoring wired to the canonical endpoint', () => {
    const render = read('render.yaml');
    const monitor = read('.github/workflows/production-health-monitor.yml');

    expect(render).toContain('healthCheckPath: /api/health/ready');
    expect(render).toContain('name: adam-financial-book-health-monitor');
    expect(render).toContain('schedule: "*/10 * * * *"');
    expect(monitor).toContain('https://adamfinancialbook.onrender.com/api/health/ready');
    expect(monitor).toContain("payload.get('database') == 'ok'");
    expect(monitor).toContain("payload.get('migrations') == 'current'");
    expect(monitor).toContain("payload.get('pendingMigrations') == 0");
  });

  it('keeps the encrypted production backup contract recoverable', () => {
    const render = read('render.yaml');
    const backup = read('server/backup-service.ts');

    expect(render).toContain('name: adam-financial-book-encrypted-backup');
    expect(render).toContain('schedule: "30 1 * * *"');
    expect(render).toContain('startCommand: npm run backup:send');
    expect(render).toContain('envVarKey: BACKUP_ENCRYPTION_KEY');
    expect(backup).toContain("createCipheriv('aes-256-gcm'");
    expect(backup).toContain("createDecipheriv('aes-256-gcm'");
    expect(backup).toContain("logOperationalEvent('backup.completed'");
    expect(backup).toContain("fireOperationalAlert('backup.failed'");
  });

  it('requires a disposable restore target and certifies a real encrypted restore drill', () => {
    const restore = read('server/restore.ts');
    const recovery = read('server/recovery.integration.test.ts');

    expect(restore).toContain('RESTORE_DATABASE_URL is required. Restore into a separate disposable database first.');
    expect(restore).toContain("process.env.ALLOW_PRODUCTION_RESTORE !== '1'");
    expect(restore).toContain("event: 'restore.verified'");
    expect(recovery).toContain('CREATE DATABASE');
    expect(recovery).toContain("createEncryptedDatabaseBackup('ci-restore-drill')");
    expect(recovery).toContain("execFileSync(npx, ['tsx', 'server/restore.ts', file]");
    expect(recovery).toContain("expect(output).toContain('restore.verified')");
    expect(recovery).toContain('expect(Number(nextAudit.rows[0].id)).toBeGreaterThan(sourceAuditId)');
    expect(recovery).toContain('modified[modified.length - 1] ^= 0xff');
    expect(recovery).toContain('toThrow(/authentication failed/i)');
  });

  it('keeps rollback and post-restore verification documented', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    expect(deployment).toContain('## Rollback procedure');
    expect(deployment).toContain('Redeploy that known-good revision');
    expect(deployment).toContain('Do not delete rows from `schema_migrations`');
    expect(deployment).toContain('## Recovery certification');
    expect(deployment).toContain('Only consider an emergency production restore after the disposable restore reports `restore.verified`');
  });
});
