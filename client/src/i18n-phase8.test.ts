import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE8_PAGE_SENTINELS, UI_CATALOG, translateStatic } from './locales';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 8 translation and internationalization contract', () => {
  it('ships deterministic French and Arabic catalog coverage for every major page', () => {
    for (const phrase of PHASE8_PAGE_SENTINELS) {
      expect(UI_CATALOG.en[phrase]).toBe(phrase);
      expect(UI_CATALOG.fr[phrase], `missing French: ${phrase}`).toBeTruthy();
      expect(UI_CATALOG.ar[phrase], `missing Arabic: ${phrase}`).toBeTruthy();
      expect(UI_CATALOG.fr[phrase], `untranslated French: ${phrase}`).not.toBe(phrase);
      expect(UI_CATALOG.ar[phrase], `untranslated Arabic: ${phrase}`).not.toBe(phrase);
    }
    expect(translateStatic('fr', '12 accounts')).toBe('12 comptes');
    expect(translateStatic('ar', '12 accounts')).toBe('12 حسابات');
    expect(translateStatic('fr', 'Today · Saturday 5 Sep 2026')).toBe('Aujourd’hui · Saturday 5 Sep 2026');
    expect(translateStatic('ar', 'Today · Saturday 5 Sep 2026')).toBe('اليوم · Saturday 5 Sep 2026');
  });

  it('uses local catalogs synchronously and defers only uncatalogued/dynamic text', () => {
    const i18n = read('client/src/i18n.tsx');
    expect(i18n).toContain("translateStatic(language, source)");
    expect(i18n).toContain('translateDynamicBatch');
    expect(i18n).toContain('setTimeout(() => { void flush(); }, 160)');
    expect(i18n).toContain("CACHE_KEY = 'book.dynamic-translation-cache.v2'");
    expect(i18n).not.toContain('window.location.reload');
    expect(i18n).not.toContain('setInterval(');
  });

  it('has one prompt/language pipeline with no obsolete competing browser wrapper', () => {
    expect(existsSync(join(root, 'client/src/browser-translation.ts'))).toBe(false);
    const bridge = read('client/src/multilingual-offline.ts');
    expect(bridge).toContain("url.pathname === '/api/read'");
    expect(bridge).toContain('const normalized = await toEnglish(original, book)');
    expect(bridge).toContain("new CustomEvent('book:language-preference'");
    expect(bridge).not.toContain('window.location.reload');
  });

  it('keeps Arabic layout RTL while financial numbers, amounts and dates stay isolated LTR', () => {
    const i18n = read('client/src/i18n.tsx');
    expect(i18n).toContain("document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'");
    expect(i18n).toContain('html[dir="rtl"] .num');
    expect(i18n).toContain('unicode-bidi: isolate');
    expect(i18n).toContain('input[type="date"]');
    expect(i18n).toContain('.chev { transform: scaleX(-1); }');
  });

  it('persists language per user without blocking the UI', () => {
    const control = read('client/src/LanguageControl.tsx');
    expect(control).toContain("fetch('/api/preferences/language'");
    expect(control).toContain('setLanguage(next)');
    expect(control.indexOf('setLanguage(next)')).toBeLessThan(control.indexOf("fetch('/api/preferences/language'"));
    const provider = read('client/src/i18n.tsx');
    expect(provider).toContain("localStorage.setItem(LANGUAGE_KEY, language)");
    expect(provider).toContain("book:language-preference");
  });

  it('keeps expensive LLMs out of the translation path and uses a durable server cache', () => {
    const server = read('server/translate.ts');
    expect(server).not.toContain('@anthropic-ai/sdk');
    expect(server).not.toContain('ANTHROPIC_TRANSLATION_MODEL');
    expect(server).toContain('GOOGLE_TRANSLATE_API_KEY');
    expect(server).toContain('CREATE TABLE IF NOT EXISTS translation_cache');
    expect(server).toContain('ON CONFLICT (language, source_hash) DO UPDATE');
  });
});
