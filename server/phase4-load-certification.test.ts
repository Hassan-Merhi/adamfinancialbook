import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 4 production-scale certification contract', () => {
  it('keeps the 500k read/write/reconnect/endurance certification', () => {
    const test = read('server/phase4-production-load-certification.integration.test.ts');

    expect(test).toContain('const EXPENSE_ENTRIES = 400_000');
    expect(test).toContain('const TRANSFER_ENTRIES = 100_000');
    expect(test).toContain('const READ_SESSIONS = 60');
    expect(test).toContain('const UNIQUE_WRITES = 100');
    expect(test).toContain('const RECONNECT_REFS = 50');
    expect(test).toContain('const RECONNECT_DUPLICATES = 4');
    expect(test).toContain('const ENDURANCE_WAVES = 10');
    expect(test).toContain('survives 60-session mixed read contention');
    expect(test).toContain('accepts 100 concurrent financial writes exactly once');
    expect(test).toContain('absorbs a 200-request reconnect retry storm');
    expect(test).toContain('survives repeated mixed-load endurance waves');
    expect(test).toContain('conserved transfer effects');
  });

  it('runs Phase 4 as a standalone exact-SHA workflow', () => {
    const workflow = read('.github/workflows/production-scale-certification.yml');
    const pkg = JSON.parse(read('package.json'));

    expect(workflow).toContain('name: Production Scale Certification');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('postgres:16');
    expect(workflow).toContain('npm run test:phase4-load');
    expect(pkg.scripts['test:phase4-load']).toContain('phase4-production-load-certification.integration.test.ts');
  });

  it('blocks stable tagging without production-scale evidence', () => {
    const release = read('.github/workflows/stable-release-tag.yml');

    expect(release).toContain("'Production Scale Certification'");
    expect(release).toContain("head_sha') == expected_sha");
    expect(release).toContain('required.issubset(chosen)');
  });
});
