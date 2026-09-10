import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 11 system closure certification', () => {
  it('keeps a standalone exact-SHA closure workflow as an explicit release gate', () => {
    const workflow = read('.github/workflows/system-closure-certification.yml');

    expect(workflow).toContain('name: System Closure Certification');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("current_main != expected_sha");
    expect(workflow).toContain("'Main Governance'");
    expect(workflow).toContain("'Production Acceptance Certification'");
    expect(workflow).toContain("'Real Device Mobile Certification'");
    expect(workflow).toContain("'Disaster Recovery Certification'");
    expect(workflow).toContain("'Production Scale Certification'");
    expect(workflow).toContain("'Accounting Chaos Certification'");
    expect(workflow).toContain("'Security'");
    expect(workflow).toContain("'CI'");
    expect(workflow).toContain("'score': '100/100'");
    expect(workflow).toContain('financialMutationByClosureWorkflow');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('system-closure-certification-${{ github.sha }}');
    expect(workflow).toMatch(/uses:\s*actions\/upload-artifact@[a-f0-9]{40}/);
  });

  it('does not auto-run full closure on a normal main push', () => {
    const workflow = read('.github/workflows/system-closure-certification.yml');

    expect(workflow).not.toContain('push:\n    branches: [main]');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('requires retained exact-SHA release evidence', () => {
    const workflow = read('.github/workflows/system-closure-certification.yml');

    expect(workflow).toContain("adam-financial-book-backup-");
    expect(workflow).toContain("real-device-mobile-certification-{expected_sha}");
    expect(workflow).toContain("final-production-certification-{expected_sha}");
    expect(workflow).toContain("production-acceptance-certification-{expected_sha}");
    expect(workflow).toContain("item.get('expired') is not False");
    expect(workflow).toContain("item.get('workflow_run', {}).get('head_sha') != expected_sha");
  });

  it('makes stable release depend on Phase 11 closure evidence', () => {
    const release = read('.github/workflows/stable-release-tag.yml');

    expect(release).toContain("'System Closure Certification'");
    expect(release).toContain("system-closure-certification-{expected_sha}");
    expect(release).toContain('systemClosureArtifactId');
    expect(release).toContain('default: p11-100-stable');
  });

  it('documents the 100/100 closure boundary without claiming fake device evidence', () => {
    const doc = read('docs/PHASE11_SYSTEM_CLOSURE.md');

    expect(doc).toContain('100/100');
    expect(doc).toContain('physical iPhone');
    expect(doc).toContain('physical Android');
    expect(doc).toContain('Production Acceptance Certification');
    expect(doc).toContain('no financial writes');
    expect(doc).toContain('manually dispatched');
  });
});
