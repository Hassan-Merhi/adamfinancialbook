import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type BookLanguage = 'en' | 'fr' | 'ar';

const LANGUAGES: { id: BookLanguage; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'fr', label: 'Français', short: 'FR' },
  { id: 'ar', label: 'العربية', short: 'AR' },
];

const LANGUAGE_KEY = 'book.language';
const CACHE_KEY = 'book.translation-cache.v1';
const MAX_BROWSER_CACHE = 1_500;

interface LanguageContextValue {
  language: BookLanguage;
  setLanguage: (language: BookLanguage) => void;
}

const LanguageContext = createContext<LanguageContextValue>({ language: 'en', setLanguage: () => {} });

/**
 * The only page that can appear before the translation API is authenticated is
 * the sign-in door. Keep its small vocabulary local so the language switch is
 * still complete before somebody signs in.
 */
const LOCAL: Record<'fr' | 'ar', Record<string, string>> = {
  fr: {
    'Set up your book': 'Configurer votre livre',
    'Financial Book': 'Livre financier',
    'Nobody can open this book yet. Choose the email and password you will use.':
      'Personne ne peut encore ouvrir ce livre. Choisissez l’adresse e-mail et le mot de passe que vous utiliserez.',
    'Email': 'E-mail',
    'Password': 'Mot de passe',
    'Opening…': 'Ouverture…',
    'Opening the book…': 'Ouverture du livre…',
    'Create the book': 'Créer le livre',
    'Open the book': 'Ouvrir le livre',
    'At least 8 characters.': 'Au moins 8 caractères.',
    'That email and password do not match.': 'Cet e-mail et ce mot de passe ne correspondent pas.',
    'Too many tries. Wait fifteen minutes and try again.': 'Trop de tentatives. Attendez quinze minutes et réessayez.',
    'Sign in to open the book.': 'Connectez-vous pour ouvrir le livre.',
  },
  ar: {
    'Set up your book': 'إعداد الدفتر المالي',
    'Financial Book': 'الدفتر المالي',
    'Nobody can open this book yet. Choose the email and password you will use.':
      'لا يمكن لأي شخص فتح هذا الدفتر بعد. اختر البريد الإلكتروني وكلمة المرور اللذين ستستخدمهما.',
    'Email': 'البريد الإلكتروني',
    'Password': 'كلمة المرور',
    'Opening…': 'جارٍ الفتح…',
    'Opening the book…': 'جارٍ فتح الدفتر…',
    'Create the book': 'إنشاء الدفتر',
    'Open the book': 'فتح الدفتر',
    'At least 8 characters.': '8 أحرف على الأقل.',
    'That email and password do not match.': 'البريد الإلكتروني وكلمة المرور غير متطابقين.',
    'Too many tries. Wait fifteen minutes and try again.': 'محاولات كثيرة جدًا. انتظر خمس عشرة دقيقة ثم حاول مرة أخرى.',
    'Sign in to open the book.': 'سجّل الدخول لفتح الدفتر.',
  },
};

interface TextState { source: string; display: string }
interface AttrState { source: string; display: string }

const textStates = new WeakMap<Text, TextState>();
const attrStates = new WeakMap<Element, Map<string, AttrState>>();
const memoryCache = new Map<string, string>();
let cacheLoaded = false;
let cacheSaveTimer: number | null = null;

function translationKey(language: BookLanguage, text: string) {
  return `${language}\u0000${text}`;
}

function loadBrowserCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    Object.entries(parsed).slice(-MAX_BROWSER_CACHE).forEach(([key, value]) => {
      if (typeof value === 'string') memoryCache.set(key, value);
    });
  } catch { /* private mode or a stale cache: translation still works */ }
}

function rememberTranslation(language: BookLanguage, source: string, translated: string) {
  loadBrowserCache();
  const key = translationKey(language, source);
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, translated);
  while (memoryCache.size > MAX_BROWSER_CACHE) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
  if (cacheSaveTimer !== null) window.clearTimeout(cacheSaveTimer);
  cacheSaveTimer = window.setTimeout(() => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(memoryCache))); }
    catch { /* the live in-memory cache is enough */ }
  }, 500);
}

function cachedTranslation(language: BookLanguage, source: string): string | undefined {
  loadBrowserCache();
  return memoryCache.get(translationKey(language, source));
}

function localTranslation(language: BookLanguage, source: string): string | undefined {
  if (language === 'en') return undefined;
  return LOCAL[language][source];
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

async function translateRemote(language: BookLanguage, texts: string[]) {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    credentials: 'same-origin',
    body: JSON.stringify({ language, texts }),
  });
  if (!response.ok) throw new Error(`translation unavailable (${response.status})`);
  const data = await response.json() as { translations?: unknown; available?: unknown };
  if (!Array.isArray(data.translations) || data.translations.length !== texts.length
      || data.translations.some((value) => typeof value !== 'string')) {
    throw new Error('translation response was incomplete');
  }
  return { translations: data.translations as string[], available: data.available !== false };
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<BookLanguage>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (saved === 'en' || saved === 'fr' || saved === 'ar') return saved;
    } catch { /* default below */ }
    return 'en';
  });
  const activeLanguage = useRef(language);

  useEffect(() => {
    activeLanguage.current = language;
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* no persistence in private mode */ }
  }, [language]);

  useEffect(() => {
    let disposed = false;
    let flushTimer: number | null = null;
    const waiting = new Map<string, Set<(translation: string) => void>>();

    const queue = (source: string, apply: (translation: string) => void) => {
      const local = localTranslation(language, source);
      if (local !== undefined) { apply(local); return; }

      const cached = cachedTranslation(language, source);
      if (cached !== undefined) { apply(cached); return; }

      const callbacks = waiting.get(source) ?? new Set<(translation: string) => void>();
      callbacks.add(apply);
      waiting.set(source, callbacks);
      if (flushTimer === null) flushTimer = window.setTimeout(flush, 90);
    };

    const flush = async () => {
      flushTimer = null;
      if (disposed || !waiting.size) return;
      const sources = [...waiting.keys()].slice(0, 80);
      const callbackSets = sources.map((source) =>
        waiting.get(source) ?? new Set<(translation: string) => void>());
      sources.forEach((source) => waiting.delete(source));

      try {
        const answer = await translateRemote(language, sources);
        if (!disposed && activeLanguage.current === language) {
          sources.forEach((source, index) => {
            const translated = answer.translations[index] ?? source;
            if (answer.available) rememberTranslation(language, source, translated);
            callbackSets[index].forEach((apply) => apply(translated));
          });
        }
      } catch {
        // Login can legitimately be unauthenticated. Local translations cover
        // that door; elsewhere the original text is safer than a broken screen.
        if (!disposed && activeLanguage.current === language) {
          sources.forEach((source, index) => callbackSets[index].forEach((apply) => apply(source)));
        }
      }

      if (waiting.size && !disposed) flushTimer = window.setTimeout(flush, 20);
    };

    const skipped = (element: Element | null) =>
      !!element?.closest('[data-no-translate],script,style,noscript,code,pre,svg,[contenteditable="true"]');

    const processText = (node: Text) => {
      const parent = node.parentElement;
      if (!parent || skipped(parent)) return;

      const current = node.data;
      let state = textStates.get(node);
      if (!state) {
        state = { source: current, display: current };
        textStates.set(node, state);
      } else if (current !== state.display) {
        // React changed the underlying content (for example a new comment or
        // balance status). That new render becomes the source of truth.
        state.source = current;
        state.display = current;
      }

      const source = state.source;
      const { before, core, after } = splitSpace(source);
      if (!worthTranslating(core)) return;

      // Never leave text from the previous selected language on screen while a
      // new translation is being fetched.
      if (state.display !== source) {
        state.display = source;
        node.data = source;
      }

      queue(core, (translated) => {
        const live = textStates.get(node);
        if (disposed || activeLanguage.current !== language || !node.isConnected || live?.source !== source) return;
        const next = `${before}${translated}${after}`;
        live.display = next;
        if (node.data !== next) node.data = next;
      });
    };

    const translatableAttrs = ['placeholder', 'title', 'aria-label', 'alt'] as const;
    const processAttribute = (element: Element, name: typeof translatableAttrs[number]) => {
      if (skipped(element)) return;
      const current = element.getAttribute(name);
      if (!current) return;

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
      const { before, core, after } = splitSpace(source);
      if (!worthTranslating(core)) return;
      if (state.display !== source) {
        state.display = source;
        element.setAttribute(name, source);
      }

      queue(core, (translated) => {
        const live = attrStates.get(element)?.get(name);
        if (disposed || activeLanguage.current !== language || !element.isConnected || live?.source !== source) return;
        const next = `${before}${translated}${after}`;
        live.display = next;
        if (element.getAttribute(name) !== next) element.setAttribute(name, next);
      });
    };

    const processElement = (element: Element) => {
      if (skipped(element)) return;
      translatableAttrs.forEach((name) => processAttribute(element, name));
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
          && translatableAttrs.includes(mutation.attributeName as typeof translatableAttrs[number])) {
          processAttribute(mutation.target, mutation.attributeName as typeof translatableAttrs[number]);
        } else {
          mutation.addedNodes.forEach(processNode);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...translatableAttrs],
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
      <div className="language-switch" data-no-translate role="group" aria-label="Language">
        {LANGUAGES.map((item) => (
          <button key={item.id} type="button" title={item.label} aria-pressed={language === item.id}
            onClick={() => setLanguage(item.id)}>{item.short}</button>
        ))}
      </div>
      <style>{LANGUAGE_CSS}</style>
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

const LANGUAGE_CSS = `
.language-switch {
  position: fixed;
  z-index: 90;
  top: 14px;
  right: 16px;
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card) 94%, transparent);
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
}
.language-switch button {
  min-width: 34px;
  height: 28px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ink-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
}
.language-switch button:hover { color: var(--ink); }
.language-switch button[aria-pressed="true"] {
  background: var(--accent);
  color: var(--paper);
}
html[dir="rtl"] body { direction: rtl; }
html[dir="rtl"] .rail { border-right: 0; border-left: 1px solid var(--line); }
html[dir="rtl"] .navbtn,
html[dir="rtl"] th,
html[dir="rtl"] .row { text-align: right; }
html[dir="rtl"] .num,
html[dir="rtl"] .val,
html[dir="rtl"] input[type="number"],
html[dir="rtl"] input[type="date"],
html[dir="rtl"] input[type="email"],
html[dir="rtl"] input[inputmode="decimal"] {
  direction: ltr;
  unicode-bidi: isolate;
}
html[dir="rtl"] .row .val,
html[dir="rtl"] td.r,
html[dir="rtl"] th.r { text-align: left; }
@media (max-width: 760px) {
  .language-switch {
    top: calc(58px + env(safe-area-inset-top));
    right: 10px;
  }
  html[dir="rtl"] .rail { border-left: 0; }
}
`;
