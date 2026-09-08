import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 1 main governance certification', () => {
  it('keeps a dedicated main governance workflow', () => {
    const workflow = read('.github/workflows/main-governance.yml');

    expect(workflow).toContain('name: Main Governance');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('Require PR branch to contain latest main');
    expect(workflow).toContain('git merge-base --is-ancestor');
    expect(workflow).toContain('Require main update to originate from merged PR');
    expect(workflow).toContain("pr.get('base', {}).get('ref') == 'main'");
    expect(workflow).toContain('Forced updates to main are not certifiable');
  });

  it('keeps critical repository paths under code ownership', () => {
    const owners = read('.github/CODEOWNERS');

    expect(owners).toContain('* @Hassan-Merhi');
    expect(owners).toContain('/.github/workflows/ @Hassan-Merhi');
    expect(owners).toContain('/server/security* @Hassan-Merhi');
    expect(owners).toContain('/server/backup* @Hassan-Merhi');
    expect(owners).toContain('/server/restore* @Hassan-Merhi');
    expect(owners).toContain('/server/migrations/ @Hassan-Merhi');
  });
});
