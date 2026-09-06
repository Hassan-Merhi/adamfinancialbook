import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile phase 2 daily flow', () => {
  it('keeps Today focused on a short recent feed', () => {
    const today = read('client/src/views/Today.tsx');
    expect(today).toContain('.reverse().slice(0, 4)');
  });

  it('collapses business money sections on phones without removing desktop cards', () => {
    const moneyView = read('client/src/views/Money.tsx');
    const css = read('client/src/daily-phase2.css');
    expect(moneyView).toContain('money-businesses-desktop');
    expect(moneyView).toContain('money-businesses-mobile');
    expect(moneyView).toContain('money-business-details');
    expect(css).toContain('.money-businesses-desktop');
    expect(css).toContain('.money-businesses-mobile');
    expect(css).toContain('.money-business-details[open]');
  });

  it('makes statement filters opt-in while keeping active filters visible', () => {
    const statement = read('client/src/views/Statement.tsx');
    const css = read('client/src/daily-phase2.css');
    expect(statement).toContain('statement-filter-toggle');
    expect(statement).toContain('const showFilters = filtersOpen || filtered');
    expect(statement).toContain('statement-filters${showFilters ? \' is-open\' : \'\'}');
    expect(css).toContain('.statement-filters.is-open');
    expect(css).toContain('display:none !important');
  });

  it('keeps optional receipt controls behind More details on phones', () => {
    const css = read('client/src/daily-phase2.css');
    expect(css).toContain('.review:not(:has(.reviewdetails)) .receipt-picker');
    expect(css).toContain('display:none');
  });

  it('loads the phase 2 refinements after the existing daily mobile layer', () => {
    const app = read('client/src/App.tsx');
    const finalPolish = read('client/src/final-polish.css');
    expect(app.indexOf("import './daily-mobile.css';")).toBeLessThan(app.indexOf("import './final-polish.css';"));
    expect(finalPolish).toContain("@import './daily-phase2.css';");
  });
});
