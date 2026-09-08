import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 5 accounting chaos certification contract', () => {
  it('keeps the destructive accounting race scenarios', () => {
    const test = read('server/phase5-accounting-chaos.integration.test.ts');
    expect(test).toContain('deduplicates a 40-request financial retry storm');
    expect(test).toContain('create → correct → correct → void');
    expect(test).toContain('serializes concurrent corrections');
    expect(test).toContain('correction racing void');
    expect(test).toContain('rejects a stale offline spend');
    expect(test).toContain('queued delegated write after the user is disabled');
    expect(test).toContain('deduplicates repeated transfer delivery');
    expect(test).toContain('global accounting invariants intact');
    expect(test).toContain('HAVING count(ef.id) <> 2 OR COALESCE(sum(ef.delta), 0) <> 0');
  });

  it('runs as a standalone PostgreSQL release certification', () => {
    const workflow = read('.github/workflows/accounting-chaos-certification.yml');
    const pkg = JSON.parse(read('package.json'));
    expect(workflow).toContain('name: Accounting Chaos Certification');
    expect(workflow).toContain('postgres:16');
    expect(workflow).toContain('npm run test:phase5-chaos');
    expect(pkg.scripts['test:phase5-chaos']).toContain('phase5-accounting-chaos.integration.test.ts');
  });

  it('blocks stable release without exact-SHA chaos evidence', () => {
    const release = read('.github/workflows/stable-release-tag.yml');
    expect(release).toContain("'Accounting Chaos Certification'");
    expect(release).toContain("head_sha') == expected_sha");
    expect(release).toContain('required.issubset(chosen)');
  });
});
