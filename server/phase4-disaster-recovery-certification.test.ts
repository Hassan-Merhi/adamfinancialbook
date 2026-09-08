import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 4 disaster recovery certification contract', () => {
  it('keeps restore drills isolated from the production database', () => {
    const restore = read('server/restore.ts');
    const boot = read('server/recovery-boot.integration.test.ts');
    expect(restore).toContain('RESTORE_DATABASE_URL is required');
    expect(restore).toContain('Refusing to restore over DATABASE_URL');
    expect(restore).toContain("ALLOW_PRODUCTION_RESTORE !== '1'");
    expect(boot).toContain('RESTORE_DATABASE_URL: sourceUrl!');
    expect(boot).toContain('toThrow()');
  });

  it('keeps authenticated encryption, tamper rejection and row/binary verification', () => {
    const recovery = read('server/recovery.integration.test.ts');
    expect(recovery).toContain("subarray(0, 4).toString('utf8')).toBe('AFB9')");
    expect(recovery).toContain('checksum).toMatch');
    expect(recovery).toContain('authentication failed');
    expect(recovery).toContain('table.rowCount');
    expect(recovery).toContain('Buffer.compare');
    expect(recovery).toContain('post restore sequence');
  });

  it('proves a restored database boots with current migrations and readiness', () => {
    const boot = read('server/recovery-boot.integration.test.ts');
    expect(boot).toContain("server/start.ts");
    expect(boot).toContain('/api/health/ready');
    expect(boot).toContain("ready.database).toBe('ok')");
    expect(boot).toContain("ready.migrations).toBe('current')");
    expect(boot).toContain('ready.pendingMigrations).toBe(0)');
  });

  it('runs the restore drill as its own blocking workflow', () => {
    const workflow = read('.github/workflows/disaster-recovery.yml');
    const pkg = read('package.json');
    expect(workflow).toContain('name: Disaster Recovery Certification');
    expect(workflow).toContain('npm run test:dr');
    expect(workflow).toContain('npm run db:integrity');
    expect(pkg).toContain('server/recovery.integration.test.ts server/recovery-boot.integration.test.ts');
  });

  it('requires disaster recovery evidence before stable release tagging', () => {
    const release = read('.github/workflows/stable-release-tag.yml');
    expect(release).toContain("'Disaster Recovery Certification'");
    expect(release).toContain("'Encrypted Production Backup'");
    expect(release).toContain("'Production Deploy Certification'");
  });
});
