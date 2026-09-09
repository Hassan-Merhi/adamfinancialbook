import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Render deployment readiness', () => {
  it('does not make stale off-site backup state block process readiness', () => {
    const readiness = read('server/readiness.ts');
    expect(readiness).toContain('const backupHealthy =');
    expect(readiness).toContain('ok: true');
    expect(readiness).toContain('release certification remains blocked');
    expect(readiness).not.toContain('ok: backupOk');
  });

  it('still blocks release acceptance when the backup is not current', () => {
    const acceptance = read('.github/workflows/production-acceptance-certification.yml');
    expect(acceptance).toContain("ready.get('backups') != 'current'");
    expect(acceptance).toContain('Production backup is not current');
  });

  it('still treats database or migration failures as unready', () => {
    const readiness = read('server/readiness.ts');
    expect(readiness).toContain("migrations: 'pending'");
    expect(readiness).toContain("database: 'error'");
    expect(readiness).toContain('ok: false');
  });
});
