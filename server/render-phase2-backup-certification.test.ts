import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Render Phase 2 encrypted production backup contract', () => {
  it('keeps the scheduled encrypted backup cron wired to the production command', () => {
    const render = read('render.yaml');
    const pkg = read('package.json');

    expect(render).toContain('name: adam-financial-book-encrypted-backup');
    expect(render).toContain('schedule: "30 1 * * *"');
    expect(render).toContain('startCommand: npm run backup:send');
    expect(render).toContain('envVarKey: BACKUP_ENCRYPTION_KEY');
    expect(render).toContain('envVarKey: DATABASE_URL');
    expect(render).toContain('key: BACKUP_MAX_EMAIL_BYTES');
    expect(pkg).toContain('"backup:send": "npm run db:migrate && tsx server/backup-mail.ts"');
  });

  it('requires authenticated encryption, a consistent snapshot, and checksums', () => {
    const service = read('server/backup-service.ts');

    expect(service).toContain("createCipheriv('aes-256-gcm'");
    expect(service).toContain('scryptSync(secret(), salt, 32)');
    expect(service).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(service).toContain('sha256(canonicalRows(rows))');
    expect(service).toContain('checksum: sha256(buffer)');
    expect(service).toContain('BACKUP_ENCRYPTION_KEY must be set to at least 32 characters');
    expect(service).toContain('Refusing to back up while');
  });

  it('records backup success/failure and emits operational alerts', () => {
    const service = read('server/backup-service.ts');
    const mail = read('server/backup-mail.ts');

    expect(service).toContain("SET status = 'success'");
    expect(service).toContain("SET status = 'failed'");
    expect(service).toContain("logOperationalEvent('backup.completed'");
    expect(service).toContain("fireOperationalAlert('backup.failed'");
    expect(mail).toContain("logOperationalEvent('backup.email.delivered'");
    expect(mail).toContain("fireOperationalAlert('backup.delivery.failed'");
    expect(mail).toContain("throw new Error('Scheduled backup delivery needs SMTP_URL");
  });

  it('keeps restore and tamper detection under integration coverage', () => {
    const recovery = read('server/recovery.integration.test.ts');

    expect(recovery).toContain("expect(artifact.buffer.subarray(0, 4).toString('utf8')).toBe('AFB9')");
    expect(recovery).toContain("expect(output).toContain('restore.verified')");
    expect(recovery).toContain('rejects a modified encrypted backup');
    expect(recovery).toContain('authentication failed');
  });
});
