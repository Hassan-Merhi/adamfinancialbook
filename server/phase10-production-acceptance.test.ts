import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const workflow = read('.github/workflows/production-acceptance-certification.yml');
const stable = read('.github/workflows/stable-release-tag.yml');
const health = read('server/health.ts');
const readiness = read('server/readiness.ts');

describe('Phase 10 production acceptance', () => {
  it('certifies the exact deployed main SHA without mutating production data', () => {
    expect(workflow).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(workflow).toContain('EXPECTED_RELEASE: ${{ github.sha }}');
    expect(workflow).toContain("method='GET'");
    expect(workflow).not.toMatch(/method=['\"](?:POST|PUT|PATCH|DELETE)['\"]/);
    expect(workflow).toContain("release == expected");
  });

  it('requires production readiness, current migrations, current backups and zero DB waiters', () => {
    for (const required of [
      "ready.get('database') != 'ok'",
      "ready.get('migrations') != 'current'",
      "ready.get('pendingMigrations') != 0",
      "ready.get('currentMigration') != ready.get('latestMigration')",
      "ready.get('backups') != 'current'",
      "pool.get('waiting', -1)",
    ]) expect(workflow).toContain(required);
  });

  it('keeps health surfaces uncached and verifies anonymous access cannot reach protected financial/owner APIs', () => {
    expect(health).toContain("Cache-Control', 'no-store'");
    expect(workflow).toContain("'/api/overview'");
    expect(workflow).toContain("'/api/operations/observability'");
    expect(workflow).toContain('status not in (401, 403)');
  });

  it('requires repeated healthy samples instead of accepting one lucky readiness response', () => {
    expect(workflow).toContain('for _ in range(3):');
    expect(workflow).toContain("sample['release'] != expected");
    expect(workflow).toContain("sample['poolWaiting'] != 0");
  });

  it('retains exact-SHA production acceptance evidence for release auditability', () => {
    expect(workflow).toContain('production-acceptance-certification-${{ github.sha }}');
    expect(workflow).toContain('retention-days: 90');
    expect(stable).toContain("'Production Acceptance Certification'");
    expect(stable).toContain('production-acceptance-certification-');
  });

  it('bases acceptance on the same readiness guarantees served by production', () => {
    expect(readiness).toContain("migrations: 'current'");
    expect(readiness).toContain("backups: backupAgeHours <= staleHours ? 'current'");
    expect(readiness).toContain('waiting: pool.waitingCount');
  });
});
