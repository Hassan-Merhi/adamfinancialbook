import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile phase 5 access and setup', () => {
  it('turns Access into focused mobile sections without replacing AccessBase behavior', () => {
    const access = read('client/src/views/Access.tsx');
    const css = read('client/src/admin-phase5.css');
    expect(access).toContain("type AccessSection = 'security' | 'password' | 'users' | 'add'");
    expect(access).toContain('phase5-access-menu');
    expect(access).toContain('<AccessBase key={revision} {...props} />');
    expect(css).toContain('[data-mobile-section="security"]');
    expect(css).toContain('[data-mobile-section="password"]');
    expect(css).toContain('[data-mobile-section="users"]');
    expect(css).toContain('[data-mobile-section="add"]');
  });

  it('turns Setup into one mobile task at a time while preserving the original setup engine', () => {
    const setup = read('client/src/views/Setup.tsx');
    const base = read('client/src/views/SetupBase.tsx');
    const css = read('client/src/admin-phase5.css');
    expect(setup).toContain('phase5-setup-menu');
    expect(setup).toContain('<SetupBase {...props} />');
    expect(setup).toContain("'businesses' | 'accounts' | 'projects' | 'people' | 'reminders' | 'openings' | 'recovery' | 'reset'");
    expect(base).toContain('outbox.setup');
    expect(base).toContain('flushOutbox(sendOfflineQueued)');
    expect(base).toContain('<OperationsPanel />');
    expect(base).toContain('<ResetData />');
    expect(css).toContain('[data-mobile-section="businesses"] #setup-businesses');
    expect(css).toContain('[data-mobile-section="reset"] .reset-card');
  });

  it('keeps mobile inputs readable and touch targets deliberate in the final admin pass', () => {
    const css = read('client/src/admin-phase5.css');
    expect(css).toContain('min-height:52px');
    expect(css).toContain('min-height:48px');
    expect(css).toContain('font-size:16px');
    expect(css).toContain('overflow-x:auto');
  });

  it('loads the five mobile structural phases in order so later fixes win predictably', () => {
    const finalPolish = read('client/src/final-polish.css');
    const imports = [
      "@import './mobile-pages.css';",
      "@import './daily-phase2.css';",
      "@import './operations-phase3.css';",
      "@import './secondary-phase4.css';",
      "@import './admin-phase5.css';",
    ];
    for (const item of imports) expect(finalPolish).toContain(item);
    for (let index = 1; index < imports.length; index += 1) {
      expect(finalPolish.indexOf(imports[index - 1])).toBeLessThan(finalPolish.indexOf(imports[index]));
    }
  });
});
