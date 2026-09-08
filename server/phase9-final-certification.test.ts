import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const stable = read('.github/workflows/stable-release-tag.yml');
const finalWorkflow = read('.github/workflows/final-production-certification.yml');
const backupWorkflow = read('.github/workflows/encrypted-production-backup.yml');

const REQUIRED = [
  'CI',
  'Security',
  'Production Deploy Certification',
  'Encrypted Production Backup',
  'Disaster Recovery Certification',
  'Real Device Mobile Certification',
  'Production Scale Certification',
  'Accounting Chaos Certification',
  'Performance Architecture Certification',
  'Production Observability Certification',
  'Final Production Certification',
];

describe('Phase 9 final production certification', () => {
  it('requires every current hardening gate on the same release SHA', () => {
    for (const name of REQUIRED) expect(stable).toContain(`'${name}'`);
    expect(stable).toContain("head_sha') == expected_sha");
    expect(stable).toContain("workflow_run', {}).get('head_sha') == expected_sha");
  });

  it('is an explicit release action, not a one-off commit-message trigger', () => {
    expect(stable).toContain('workflow_dispatch:');
    expect(stable).toContain('target_sha:');
    expect(stable).not.toContain("contains(github.event.head_commit.message");
    expect(stable).toContain("/branches/main");
  });

  it('requires retained backup, physical-device and final certification evidence', () => {
    expect(stable).toContain('adam-financial-book-backup-');
    expect(stable).toContain('real-device-mobile-certification-');
    expect(stable).toContain('final-production-certification-');
  });

  it('runs final certification on PRs and main pushes', () => {
    expect(finalWorkflow).toContain('pull_request:');
    expect(finalWorkflow).toContain('push:');
    expect(finalWorkflow).toContain('branches: [main]');
    expect(finalWorkflow).toContain('npm run test:phase9-final');
    expect(finalWorkflow).toContain('npm run certify:production');
  });

  it('retains an exact-SHA final certification artifact', () => {
    expect(finalWorkflow).toContain('final-production-certification-${{ github.sha }}');
    expect(finalWorkflow).toContain('retention-days: 90');
    expect(finalWorkflow).toContain('github.sha');
  });

  it('forces a fresh exact-release encrypted backup when Phase 9 release governance changes', () => {
    expect(backupWorkflow).toContain("'.github/workflows/stable-release-tag.yml'");
    expect(backupWorkflow).toContain("'.github/workflows/final-production-certification.yml'");
    expect(backupWorkflow).toContain('EXPECTED_RELEASE: ${{ github.sha }}');
  });
});
