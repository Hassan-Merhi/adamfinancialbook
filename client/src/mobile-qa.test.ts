import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('mobile performance contract', () => {
  it('keeps secondary pages out of the initial React dependency graph and avoids periodic polling', () => {
    const app = read('client/src/App.tsx');
    for (const page of ['Money', 'Projects', 'People', 'Attention', 'Report', 'Setup', 'History', 'Access', 'Files', 'Approvals', 'Statement']) {
      expect(app).not.toMatch(new RegExp(`import ${page} from ['\"]\\./views/${page}['\"]`));
      expect(app).toContain(`import('./views/${page}')`);
    }
    expect(app).not.toMatch(/import GlobalSearch from ['"]\.\/GlobalSearch['"]/);
    expect(app).toContain("import('./GlobalSearch')");
    expect(app).not.toContain('DASHBOARD_REFRESH_MOBILE_MS');
    expect(app).not.toContain('DASHBOARD_REFRESH_DESKTOP_MS');
    expect(app).not.toContain('setInterval(');
    expect(app).toContain("window.addEventListener('focus', resume)");
    expect(app).toContain("document.addEventListener('visibilitychange', resume)");
  });

  it('keeps the phone viewport, safe areas, RTL and reduced-motion contracts', () => {
    const html = read('client/index.html');
    const core = read('client/src/mobile-core.css');
    const admin = read('client/src/admin-mobile.css');
    const perf = read('client/src/performance-mobile.css');
    expect(html).toContain('viewport-fit=cover');
    expect(`${core}\n${admin}`).toContain('env(safe-area-inset-bottom)');
    expect(`${core}\n${admin}`).toMatch(/dir=["']rtl["']/);
    expect(perf).toContain('@media(max-width:760px)');
    expect(perf).toContain('font-size:16px');
    expect(perf).toContain('overflow-x:clip');
    expect(perf).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('loads only the active font family for the retained default look', () => {
    const html = read('client/index.html');
    expect(html).toContain('family=Inter');
    expect(html).not.toContain('Archivo');
    expect(html).not.toContain('IBM+Plex');
    expect(html).not.toContain('Source+Sans');
  });

  it('never caches APIs and uses hashed assets for fast repeat launches', () => {
    const worker = read('client/public/sw.js');
    expect(worker).toContain("url.pathname.startsWith('/api')");
    expect(worker).toContain("url.pathname.startsWith('/assets/')");
    expect(worker).toContain("CACHE = 'book-shell-v2'");
    expect(worker).toContain("request.mode === 'navigate'");
    expect(() => new Function(worker)).not.toThrow();
  });
});
