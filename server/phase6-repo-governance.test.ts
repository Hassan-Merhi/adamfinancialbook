import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workflowsDir = join(root, '.github', 'workflows');

function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

describe('Phase 6 repository governance guardrails', () => {
  it('keeps main governance active for pull requests and direct main updates', () => {
    const workflow = read('.github/workflows/main-governance.yml');
    expect(workflow).toMatch(/pull_request:\s*\n\s*branches:\s*\[main\]/);
    expect(workflow).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(workflow).toContain('Require PR branch to contain latest main');
    expect(workflow).toContain('Require main update to originate from merged PR');
    expect(workflow).toContain('FORCED_PUSH: ${{ github.event.forced }}');
    expect(workflow).toContain('Forced updates to main are not certifiable.');
    expect(workflow).toContain("pr.get('base', {}).get('ref') == 'main'");
  });

  it('keeps governance credentials read-only and checkout credentials disabled', () => {
    const workflow = read('.github/workflows/main-governance.yml');
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/);
    expect(workflow).toContain('persist-credentials: false');
  });

  it('never enables pull_request_target in repository workflows', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name))) {
      const workflow = readFileSync(join(workflowsDir, file), 'utf8');
      if (/^\s*pull_request_target\s*:/m.test(workflow)) offenders.push(file);
    }
    expect(offenders, `Unsafe pull_request_target workflows found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps dependency automation for npm and GitHub Actions with cooldowns', () => {
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    expect((dependabot.match(/cooldown:/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((dependabot.match(/default-days:\s*7/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps code ownership on repository-wide and critical release/security paths', () => {
    const owners = read('.github/CODEOWNERS');
    expect(owners).toMatch(/^\*\s+@Hassan-Merhi$/m);
    expect(owners).toMatch(/^\/\.github\/workflows\/\s+@Hassan-Merhi$/m);
    expect(owners).toMatch(/^\/server\/security\*\s+@Hassan-Merhi$/m);
    expect(owners).toMatch(/^\/server\/backup\*\s+@Hassan-Merhi$/m);
    expect(owners).toMatch(/^\/server\/restore\*\s+@Hassan-Merhi$/m);
    expect(owners).toMatch(/^\/server\/migrations\/\s+@Hassan-Merhi$/m);
  });
});
