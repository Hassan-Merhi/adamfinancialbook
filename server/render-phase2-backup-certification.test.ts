import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Render Phase 2 encrypted production backup contract', () => {
  it('keeps the nightly encrypted off-site backup wired without SMTP secrets', () => {
    const render = read('render.yaml');
    const workflow = read('.github/workflows/encrypted-production-backup.yml');
    const exportRoute = read('server/backup-export.ts');
    const delivery = read('server/backup-delivery.ts');

    expect(render).not.toContain('name: adam-financial-book-encrypted-backup');
    expect(render).toContain('key: BACKUP_ENCRYPTION_KEY');
    expect(workflow).toContain("cron: '30 1 * * *'");
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('OIDC_AUDIENCE: adam-financial-book-backup');
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).not.toContain('DATABASE_URL:');
    expect(workflow).not.toContain('BACKUP_ENCRYPTION_KEY:');
    expect(exportRoute).toContain("createEncryptedDatabaseBackup('github-actions-export')");
    expect(delivery).toContain("destination = 'github-actions-artifact'");
  });

  it('requires authenticated encryption, a consistent snapshot, and checksums', () => {
    const service = read('server/backup-service.ts');

    expect(service).toContain("createCipheriv('aes-256-gcm'");
    expect(service).toContain('scryptSync(secret(), salt, 32)');
    expect(service).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(service).toContain('sha256(canonicalRows(rows))');
    expect(service).toContain('const checksum = sha256(buffer)');
    expect(service).toContain('checksum,');
    expect(service).toContain('BACKUP_ENCRYPTION_KEY must be set to at least 32 characters');
    expect(service).toContain('Refusing to back up while');
  });

  it('records backup creation, durable delivery, and failure alerts', () => {
    const service = read('server/backup-service.ts');
    const workflow = read('.github/workflows/encrypted-production-backup.yml');
    const delivery = read('server/backup-delivery.ts');

    expect(service).toContain("SET status = 'success'");
    expect(service).toContain("SET status = 'failed'");
    expect(service).toContain("logOperationalEvent('backup.completed'");
    expect(service).toContain("fireOperationalAlert('backup.failed'");
    expect(delivery).toContain('delivered_at = now()');
    expect(delivery).toContain('artifact_digest');
    expect(delivery).toContain('retention_until');
    expect(workflow).toContain('[Production Backup] Adam Financial Book encrypted backup failure');
    expect(workflow).toContain('Close recovered backup incident');
  });

  it('keeps restore and tamper detection under integration coverage', () => {
    const recovery = read('server/recovery.integration.test.ts');

    expect(recovery).toContain("expect(artifact.buffer.subarray(0, 4).toString('utf8')).toBe('AFB9')");
    expect(recovery).toContain("expect(output).toContain('restore.verified')");
    expect(recovery).toContain('rejects a modified encrypted backup');
    expect(recovery).toContain('authentication failed');
  });
});
