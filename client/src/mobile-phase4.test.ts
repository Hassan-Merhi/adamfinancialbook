import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile phase 4 secondary pages', () => {
  it('keeps report totals visible while moving detail into mobile disclosures', () => {
    const report = read('client/src/views/Report.tsx');
    const css = read('client/src/secondary-phase4.css');
    expect(report).toContain('report-desktop-details');
    expect(report).toContain('report-mobile-details');
    expect(report).toContain('ReportDisclosure title="Money in & out"');
    expect(report).toContain('ReportDisclosure title="Outstanding"');
    expect(css).toContain('.report-desktop-details { display:none; }');
    expect(css).toContain('.report-mobile-details');
  });

  it('keeps file search visible and moves advanced filters into a mobile dialog sheet', () => {
    const files = read('client/src/views/FilesBase.tsx');
    const css = read('client/src/secondary-phase4.css');
    expect(files).toContain('files-mobile-tools');
    expect(files).toContain('files-filter-toggle');
    expect(files).toContain('role="dialog"');
    expect(files).toContain('files-filter-sheet');
    expect(files).toContain('advancedFilterCount');
    expect(css).toContain('.files-filter-desktop { display:none; }');
    expect(css).toContain('position:fixed;');
  });

  it('reduces mobile file-card metadata until details are requested', () => {
    const files = read('client/src/views/FilesBase.tsx');
    const css = read('client/src/secondary-phase4.css');
    expect(files).toContain('file-meta-desktop');
    expect(files).toContain('file-mobile-meta');
    expect(files).toContain('file-mobile-details');
    expect(css).toContain('.file-meta-desktop { display:none; }');
    expect(css).toContain('.file-mobile-details');
  });

  it('makes the history audit trail primary and tucks exports and voided entries into mobile tools', () => {
    const history = read('client/src/views/HistoryBase.tsx');
    const css = read('client/src/secondary-phase4.css');
    expect(history.indexOf('{auditTrail}')).toBeLessThan(history.indexOf('history-mobile-tools'));
    expect(history).toContain('Exports & backup');
    expect(history).toContain('Voided entries');
    expect(css).toContain('.history-desktop-tools { display:none; }');
    expect(css).toContain('.history-mobile-tools');
  });

  it('loads the Phase 4 structural layer after the earlier mobile phases', () => {
    const finalPolish = read('client/src/final-polish.css');
    expect(finalPolish.indexOf("@import './operations-phase3.css';"))
      .toBeLessThan(finalPolish.indexOf("@import './secondary-phase4.css';"));
  });
});
