import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { heuristicLanguage, protectTranslationText, restoreTranslationText, type SupportedLanguage } from '../../shared/language';
import { translateStatic, type BookLanguage } from './locales';

export type { BookLanguage } from './locales';

interface LanguageContextValue {
  language: BookLanguage;
  setLanguage: (language: BookLanguage) => void;
}

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}

interface TranslatorFactory {
  availability?: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}

interface TextState { source: string; display: string }
interface AttrState { source: string; display: string }

const LanguageContext = createContext<LanguageContextValue>({ language: 'en', setLanguage: () => {} });
const LANGUAGE_KEY = 'book.language';
const CACHE_KEY = 'book.dynamic-translation-cache.v2';
const MAX_CACHE = 2_000;
const textStates = new WeakMap<Text, TextState>();
const attrStates = new WeakMap<Element, Map<string, AttrState>>();
const memoryCache = new Map<string, string>();
const translatorPromises = new Map<string, Promise<ChromeTranslator | null>>();
let cacheLoaded = false;
let cacheSaveTimer: number | null = null;

function isLanguage(value: unknown): value is BookLanguage {
  return value === 'en' || value === 'fr' || value === 'ar';
}

function factory(): TranslatorFactory | null {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator ?? null;
}

function cacheKey(language: BookLanguage, source: string) {
  return `${language}\u0000${source}`;
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    Object.entries(parsed).slice(-MAX_CACHE).forEach(([key, value]) => {
      if (typeof value === 'string') memoryCache.set(key, value);
    });
  } catch { /* private mode or stale cache */ }
}

function remember(language: BookLanguage, source: string, translated: string) {
  loadCache();
  const key = cacheKey(language, source);
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, translated);
  while (memoryCache.size > MAX_CACHE) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
  if (cacheSaveTimer !== null) window.clearTimeout(cacheSaveTimer);
  cacheSaveTimer = window.setTimeout(() => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(memoryCache))); }
    catch { /* in-memory cache remains usable */ }
  }, 400);
}

function cached(language: BookLanguage, source: string) {
  loadCache();
  return memoryCache.get(cacheKey(language, source));
}

function pairKey(source: SupportedLanguage, target: SupportedLanguage) {
  return `${source}>${target}`;
}

async function getTranslator(source: SupportedLanguage, target: SupportedLanguage): Promise<ChromeTranslator | null> {
  if (source === target) return null;
  const api = factory();
  if (!api) return null;
  const key = pairKey(source, target);
  const existing = translatorPromises.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      if (api.availability) {
        const availability = await api.availability({ sourceLanguage: source, targetLanguage: target });
        if (availability === 'unavailable' || availability === 'no') return null;
      }
      return await api.create({ sourceLanguage: source, targetLanguage: target });
    } catch {
      translatorPromises.delete(key);
      return null;
    }
  })();
  translatorPromises.set(key, pending);
  return pending;
}

function snapshotNames(): string[] {
  try {
    const raw = localStorage.getItem('book.snapshot');
    if (!raw) return [];
    const book = JSON.parse(raw) as Record<string, unknown>;
    const names = ['businesses', 'accounts', 'projects', 'people'].flatMap((key) => {
      const rows = book[key];
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const name = (row as Record<string, unknown>).name;
        return typeof name === 'string' && name.trim() ? [name.trim()] : [];
      });
    });
    return [...new Set(names)].sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

async function translateLocal(source: SupportedLanguage, target: SupportedLanguage, text: string): Promise<string | null> {
  if (source === target) return text;
  const direct = await getTranslator(source, target);
  if (direct) {
    try { return await direct.translate(text); }
    catch { /* try English pivot below */ }
  }
  if (source !== 'en' && target !== 'en') {
    const toEnglish = await getTranslator(source, 'en');
    const fromEnglish = await getTranslator('en', target);
    if (toEnglish && fromEnglish) {
      try { return await fromEnglish.translate(await toEnglish.translate(text)); }
      catch { /* server fallback below */ }
    }
  }
  return null;
}

async function serverFallback(target: BookLanguage, texts: string[]): Promise<string[] | null> {
  if (!texts.length) return [];
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language: target, texts }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { translations?: unknown; available?: unknown };
    if (data.available === false || !Array.isArray(data.translations)
      || data.translations.length !== texts.length
      || data.translations.some((value) => typeof value !== 'string')) return null;
    return data.translations as string[];
  } catch {
    return null;
  }
}

async function translateDynamicBatch(language: BookLanguage, sources: string[]): Promise<string[]> {
  if (language === 'en') return [...sources];
  const names = snapshotNames();
  const output = [...sources];
  const unresolved: Array<{ index: number; source: string; masked: string; protectedText: ReturnType<typeof protectTranslationText> }> = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= sources.length) return;
      const source = sources[index];
      const hit = cached(language, source);
      if (hit !== undefined) { output[index] = hit; continue; }
      const sourceLanguage = heuristicLanguage(source);
      if (sourceLanguage === language) { output[index] = source; remember(language, source, source); continue; }
      const protectedText = protectTranslationText(source, names);
      const translated = await translateLocal(sourceLanguage, language, protectedText.masked);
      if (translated !== null) {
        const restored = restoreTranslationText(translated, protectedText);
        output[index] = restored;
        remember(language, source, restored);
      } else {
        unresolved.push({ index, source, masked: protectedText.masked, protectedText });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, () => worker()));
  if (unresolved.length) {
    const fallback = await serverFallback(language, unresolved.map((item) => item.masked));
    if (fallback) {
      unresolved.forEach((item, index) => {
        const restored = restoreTranslationText(fallback[index] ?? item.masked, item.protectedText);
        output[item.index] = restored;
        remember(language, item.source, restored);
      });
    }
  }
  return output;
}

function splitSpace(value: string) {
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { before: match?.[1] ?? '', core: match?.[2] ?? value, after: match?.[3] ?? '' };
}

function worthTranslating(text: string) {
  const value = text.trim();
  if (!value || !/\p{L}/u.test(value)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  if (/^(https?:\/\/|www\.)/i.test(value)) return false;
  return true;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<BookLanguage>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (isLanguage(saved)) return saved;
    } catch { /* default below */ }
    return 'en';
  });
  const activeLanguage = useRef(language);

  useEffect(() => {
    const adopt = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isLanguage(next)) setLanguage(next);
    };
    window.addEventListener('book:language-preference', adopt);
    return () => window.removeEventListener('book:language-preference', adopt);
  }, []);

  useEffect(() => {
    activeLanguage.current = language;
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent('book:language-change', { detail: language }));
  }, [language]);

  useEffect(() => {
    let disposed = false;
    let flushTimer: number | null = null;
    const waiting = new Map<string, Set<(translation: string) => void>>();

    const flush = async () => {
      flushTimer = null;
      if (disposed || !waiting.size || language === 'en') return;
      const sources = [...waiting.keys()].slice(0, 40);
      const callbacks = sources.map((source) => waiting.get(source) ?? new Set<(translation: string) => void>());
      sources.forEach((source) => waiting.delete(source));
      const translations = await translateDynamicBatch(language, sources);
      if (!disposed && activeLanguage.current === language) {
        sources.forEach((source, index) => callbacks[index].forEach((apply) => apply(translations[index] ?? source)));
      }
      if (waiting.size && !disposed) flushTimer = window.setTimeout(() => { void flush(); }, 40);
    };

    const queueDynamic = (source: string, apply: (translation: string) => void) => {
      const hit = cached(language, source);
      if (hit !== undefined) { apply(hit); return; }
      const callbacks = waiting.get(source) ?? new Set<(translation: string) => void>();
      callbacks.add(apply);
      waiting.set(source, callbacks);
      // Dynamic/user-entered text is deliberately deferred so language switching
      // never blocks startup or navigation. Reviewed structural copy translates
      // synchronously from the local catalog above.
      if (flushTimer === null) flushTimer = window.setTimeout(() => { void flush(); }, 160);
    };

    const skipped = (element: Element | null) =>
      !!element?.closest('[data-no-translate],script,style,noscript,code,pre,svg,[contenteditable="true"]');

    const translateCore = (source: string, apply: (translation: string) => void) => {
      if (language === 'en') { apply(source); return; }
      const local = translateStatic(language, source);
      if (local !== null) { apply(local); return; }
      if (worthTranslating(source)) queueDynamic(source, apply);
    };

    const processText = (node: Text) => {
      const parent = node.parentElement;
      if (!parent || skipped(parent)) return;
      const current = node.data;
      let state = textStates.get(node);
      if (!state) {
        state = { source: current, display: current };
        textStates.set(node, state);
      } else if (current !== state.display) {
        state.source = current;
        state.display = current;
      }
      const source = state.source;
      const { before, core, after } = splitSpace(source);
      if (!worthTranslating(core)) return;
      translateCore(core, (translated) => {
        const live = textStates.get(node);
        if (disposed || activeLanguage.current !== language || !node.isConnected || live?.source !== source) return;
        const next = `${before}${translated}${after}`;
        live.display = next;
        if (node.data !== next) node.data = next;
      });
    };

    const attrs = ['placeholder', 'title', 'aria-label', 'alt'] as const;
    const processAttribute = (element: Element, name: typeof attrs[number]) => {
      if (skipped(element)) return;
      const current = element.getAttribute(name);
      if (!current || !worthTranslating(current)) return;
      let states = attrStates.get(element);
      if (!states) { states = new Map(); attrStates.set(element, states); }
      let state = states.get(name);
      if (!state) {
        state = { source: current, display: current };
        states.set(name, state);
      } else if (current !== state.display) {
        state.source = current;
        state.display = current;
      }
      const source = state.source;
      translateCore(source, (translated) => {
        const live = attrStates.get(element)?.get(name);
        if (disposed || activeLanguage.current !== language || !element.isConnected || live?.source !== source) return;
        live.display = translated;
        if (element.getAttribute(name) !== translated) element.setAttribute(name, translated);
      });
    };

    const processElement = (element: Element) => {
      if (skipped(element)) return;
      attrs.forEach((name) => processAttribute(element, name));
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) processText(child as Text);
        else if (child.nodeType === Node.ELEMENT_NODE) processElement(child as Element);
      }
    };

    const processNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) processText(node as Text);
      else if (node.nodeType === Node.ELEMENT_NODE) processElement(node as Element);
    };

    if (document.body) processElement(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') processNode(mutation.target);
        else if (mutation.type === 'attributes' && mutation.target instanceof Element && mutation.attributeName
          && attrs.includes(mutation.attributeName as typeof attrs[number])) {
          processAttribute(mutation.target, mutation.attributeName as typeof attrs[number]);
        } else mutation.addedNodes.forEach(processNode);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...attrs],
    });

    return () => {
      disposed = true;
      observer.disconnect();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      waiting.clear();
    };
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage }), [language]);
  return (
    <LanguageContext.Provider value={value}>
      {children}
      <style>{I18N_CSS}</style>
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

const I18N_CSS = `
html[dir="rtl"] body { direction: rtl; }
html[dir="rtl"] .num,
html[dir="rtl"] [data-ltr],
html[dir="rtl"] input[type="number"],
html[dir="rtl"] input[type="date"] {
  direction: ltr;
  unicode-bidi: isolate;
}
html[dir="rtl"] input:not([type="number"]):not([type="date"]),
html[dir="rtl"] textarea { text-align: right; }
html[dir="rtl"] .chev { transform: scaleX(-1); }
html[dir="rtl"] .language-control { direction: rtl; }
`;
