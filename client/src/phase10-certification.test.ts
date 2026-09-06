import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 10 final production certification contract', () => {
  it('keeps startup small and every secondary page route lazy', () => {
    const app = read('client/src/App.tsx');
    for (const page of ['Money', 'Projects', 'People', 'Attention', 'Report', 'Setup', 'History', 'Access', 'Files', 'Approvals', 'Statement']) {
      expect(app).toContain(`import('./views/${page}')`);
      expect(app).not.toMatch(new RegExp(`import ${page} from ['\"]\\./views/${page}['\"]`));
    }
    expect(app).toContain("import('./GlobalSearch')");
    expect(app).not.toMatch(/import GlobalSearch from ['"]\.\/GlobalSearch['"]/);
  });

  it('uses standards-based active navigation and one real More backdrop', () => {
    const app = read('client/src/App.tsx');
    const nav = read('client/src/navigation.css');
    const polish = read('client/src/final-polish.css');
    expect(app).toContain("? 'page' : undefined");
    expect(nav).toContain('[aria-current="page"]');
    expect(nav).not.toContain('[aria-current="true"]');
    expect(nav).not.toContain('.moremenu::before');
    expect(nav).not.toContain('.moregroup:has(.moremenu)::before');
    expect(app).toContain('className="morebackdrop"');
    expect(polish).toContain('.morebackdrop');
  });

  it('traps and restores focus for both modal surfaces', () => {
    const hook = read('client/src/dialog-a11y.ts');
    const app = read('client/src/App.tsx');
    const search = read('client/src/GlobalSearch.tsx');
    expect(hook).toContain("event.key === 'Escape'");
    expect(hook).toContain("event.key !== 'Tab'");
    expect(hook).toContain("document.body.style.overflow = 'hidden'");
    expect(hook).toContain('restore.focus({ preventScroll: true })');
    expect(app).toContain('useModalFocus(moreOpen');
    expect(search).toContain('useModalFocus(open, dialog, onClose, input)');
    expect(app).toContain('aria-labelledby="more-menu-title"');
    expect(search).toContain('aria-modal="true"');
  });

  it('keeps keyboard focus visible and touch controls large enough', () => {
    const polish = read('client/src/final-polish.css');
    expect(polish).toContain(':focus-visible');
    expect(polish).toContain('@media (pointer:coarse)');
    expect(polish).toContain('min-height:44px');
    expect(polish).toContain('@media (prefers-reduced-motion:reduce)');
  });

  it('uses native sign-in form semantics and password-manager hints', () => {
    const signIn = read('client/src/views/SignIn.tsx');
    expect(signIn).toContain('<form className="form door-form"');
    expect(signIn).toContain('onSubmit={(event) =>');
    expect(signIn).toContain('autoComplete="username"');
    expect(signIn).toContain("autoComplete={needsFirstOwner ? 'new-password' : 'current-password'}");
    expect(signIn).toContain('type="submit"');
    expect(signIn).toContain('aria-pressed={showPassword}');
  });

  it('persists appearance, names the current page, and avoids conflicting modals', () => {
    const app = read('client/src/App.tsx');
    const main = read('client/src/main.tsx');
    expect(main).toContain("localStorage.getItem('book.theme')");
    expect(app).toContain("localStorage.setItem('book.theme', next)");
    expect(app).toContain('document.title = current === \'Today\'');
    expect(app).toContain('setMoreOpen(false);\n        void loadGlobalSearch();');
    expect(app).toContain("behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'");
  });

  it('keeps owner-only search visibility explicit and offline/PWA safety intact', () => {
    const app = read('client/src/App.tsx');
    const worker = read('client/public/sw.js');
    expect(app).toContain("owner={me.user.role === 'owner'}");
    expect(worker).toContain("url.pathname.startsWith('/api')");
    expect(worker).toContain("request.mode === 'navigate'");
    expect(existsSync(join(root, 'client/src/browser-translation.ts'))).toBe(false);
  });

  it('requires a clean accounting integrity check in CI after financial E2E', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('Financial end-to-end reconciliation');
    expect(ci).toContain('Final database integrity certification');
    expect(ci.indexOf('Final database integrity certification'))
      .toBeGreaterThan(ci.indexOf('Financial end-to-end reconciliation'));
    expect(ci).toContain('npm run db:integrity');
  });
});
