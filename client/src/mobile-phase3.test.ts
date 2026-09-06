import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile phase 3 operational drill-downs', () => {
  it('keeps Projects primary and folds secondary waiting receipts on phones', () => {
    const projects = read('client/src/views/Projects.tsx');
    const css = read('client/src/operations-phase3.css');
    expect(projects).toContain('projects-waiting-desktop');
    expect(projects).toContain('projects-waiting-mobile');
    expect(projects).toContain('operations-mobile-fold');
    expect(css).toContain('.projects-waiting-desktop');
    expect(css).toContain('.projects-waiting-mobile');
  });

  it('turns People into mobile category drill-downs without removing desktop groups', () => {
    const people = read('client/src/views/People.tsx');
    const css = read('client/src/operations-phase3.css');
    expect(people).toContain('people-desktop-groups');
    expect(people).toContain('people-mobile-groups');
    expect(people).toContain('operations-mobile-group');
    expect(css).toContain('.people-desktop-groups');
    expect(css).toContain('.people-mobile-groups');
  });

  it('turns Needs Attention into four focused mobile inbox categories', () => {
    const attention = read('client/src/views/Attention.tsx');
    const css = read('client/src/operations-phase3.css');
    for (const section of ['review', 'decisions', 'receipts', 'followup']) {
      expect(attention).toContain(`data-attention-section="${section}"`);
    }
    expect(attention).toContain('attention-mobile-nav');
    expect(attention).toContain("type AttentionSection = 'review' | 'decisions' | 'receipts' | 'followup'");
    expect(css).toContain('.attention-section.is-active');
    expect(css).toContain('.attention-summary-desktop');
  });

  it('shows one Approvals/My Wallet workflow at a time on phones', () => {
    const approvals = read('client/src/views/ApprovalsBase.tsx');
    const css = read('client/src/operations-phase3.css');
    expect(approvals).toContain('approval-mobile-nav');
    expect(approvals).toContain('data-approval-section="requests"');
    expect(approvals).toContain('data-approval-section="access"');
    expect(approvals).toContain('data-approval-section="cash"');
    expect(approvals).toContain('data-approval-section="incoming"');
    expect(approvals).toContain('approval-history-row');
    expect(css).toContain('.approval-section.is-active');
    expect(css).toContain('.approval-history-row:not(.is-shown)');
  });

  it('loads Phase 3 after the earlier mobile layers and restores readable phone type', () => {
    const finalPolish = read('client/src/final-polish.css');
    const css = read('client/src/operations-phase3.css');
    expect(finalPolish.indexOf("@import './daily-phase2.css';"))
      .toBeLessThan(finalPolish.indexOf("@import './operations-phase3.css';"));
    expect(css).toContain('font-size:11.5px');
    expect(css).toContain('min-height:44px');
  });
});
