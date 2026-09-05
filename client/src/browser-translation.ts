import { heuristicLanguage, protectTranslationText, restoreTranslationText, type SupportedLanguage } from '../../shared/language';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available' | string;

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}

interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
}

interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: DownloadMonitor) => void;
  }): Promise<ChromeTranslator>;
}

interface LanguageDetection {
  detectedLanguage: string;
  confidence: number;
}

interface ChromeLanguageDetector {
  detect(text: string): Promise<LanguageDetection[]>;
  destroy?: () => void;
}

interface LanguageDetectorFactory {
  availability(): Promise<Availability>;
  create(options?: { monitor?: (monitor: DownloadMonitor) => void }): Promise<ChromeLanguageDetector>;
}

const nativeFetch = window.fetch.bind(window);
const translatorPromises = new Map<string, Promise<ChromeTranslator | null>>();
let detectorPromise: Promise<ChromeLanguageDetector | null> | null = null;
let catalogNames: string[] = [];
let statusHideTimer: number | null = null;

const ENGINE_VERSION = 'book.translation-engine.v3';
const LANGUAGE_KEY = 'book.language';
const DISPLAY_CONCURRENCY = 6;

// The old cache assumed every source string was English. Throw it away once so
// Arabic/French originals can be translated correctly in every direction.
try {
  if (localStorage.getItem(ENGINE_VERSION) !== 'ready') {
    localStorage.removeItem('book.translation-cache.v1');
    localStorage.setItem(ENGINE_VERSION, 'ready');
  }
} catch { /* private mode */ }

function translatorFactory(): TranslatorFactory | null {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator ?? null;
}

function detectorFactory(): LanguageDetectorFactory | null {
  return (globalThis as typeof globalThis & { LanguageDetector?: LanguageDetectorFactory }).LanguageDetector ?? null;
}

function pairKey(sourceLanguage: SupportedLanguage, targetLanguage: SupportedLanguage) {
  return `${sourceLanguage}>${targetLanguage}`;
}

const STATUS_COPY: Record<SupportedLanguage, Record<'downloading' | 'translating' | 'ready' | 'unavailable', string>> = {
  en: {
    downloading: 'Downloading translation language…',
    translating: 'Translating…',
    ready: 'Translation ready',
    unavailable: 'Local translation is unavailable in this browser',
  },
  fr: {
    downloading: 'Téléchargement de la langue…',
    translating: 'Traduction…',
    ready: 'Traduction prête',
    unavailable: 'La traduction locale n’est pas disponible dans ce navigateur',
  },
  ar: {
    downloading: 'جارٍ تنزيل لغة الترجمة…',
    translating: 'جارٍ الترجمة…',
    ready: 'الترجمة جاهزة',
    unavailable: 'الترجمة المحلية غير متاحة في هذا المتصفح',
  },
};

function statusElement() {
  let element = document.getElementById('book-translation-status');
  if (element) return element;
  if (!document.body) return null;
  element = document.createElement('div');
  element.id = 'book-translation-status';
  element.setAttribute('data-no-translate', '');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;
  document.body.appendChild(element);

  if (!document.getElementById('book-translation-status-style')) {
    const style = document.createElement('style');
    style.id = 'book-translation-status-style';
    style.textContent = `
#book-translation-status {
  position: fixed; z-index: 91; top: 52px; right: 16px; max-width: min(360px, calc(100vw - 32px));
  padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px;
  background: color-mix(in srgb, var(--card) 96%, transparent); color: var(--ink-2);
  box-shadow: var(--shadow); font-size: 12px; font-weight: 650; backdrop-filter: blur(10px);
}
html[dir="rtl"] #book-translation-status { right: auto; left: 16px; }
#book-translation-status[data-kind="unavailable"] { color: var(--danger, #b84a4a); }
@media (max-width: 760px) {
  #book-translation-status { top: calc(96px + env(safe-area-inset-top)); right: 10px; }
  html[dir="rtl"] #book-translation-status { right: auto; left: 10px; }
}`;
    document.head.appendChild(style);
  }
  return element;
}

function setStatus(
  kind: 'downloading' | 'translating' | 'ready' | 'unavailable',
  targetLanguage: SupportedLanguage,
  progress?: number,
) {
  const element = statusElement();
  if (!element) return;
  if (statusHideTimer !== null) window.clearTimeout(statusHideTimer);
  element.dataset.kind = kind;
  const pct = kind === 'downloading' && typeof progress === 'number'
    ? ` ${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`
    : '';
  element.textContent = `${STATUS_COPY[targetLanguage][kind]}${pct}`;
  element.hidden = false;
  if (kind === 'ready') {
    statusHideTimer = window.setTimeout(() => { element.hidden = true; }, 1800);
  }
}

function createNow(
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<ChromeTranslator | null> {
  if (sourceLanguage === targetLanguage) return Promise.resolve(null);
  const api = translatorFactory();
  if (!api) return Promise.resolve(null);

  const key = pairKey(sourceLanguage, targetLanguage);
  const existing = translatorPromises.get(key);
  if (existing) return existing;

  const pending = api.create({
    sourceLanguage,
    targetLanguage,
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        setStatus('downloading', targetLanguage, event.loaded);
      });
    },
  }).catch((error) => {
    translatorPromises.delete(key);
    console.warn(`Chrome translation ${key} could not start:`, (error as Error).message);
    return null;
  });

  translatorPromises.set(key, pending);
  return pending;
}

async function getTranslator(
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<ChromeTranslator | null> {
  if (sourceLanguage === targetLanguage) return null;
  const existing = translatorPromises.get(pairKey(sourceLanguage, targetLanguage));
  if (existing) return existing;

  const api = translatorFactory();
  if (!api) return null;
  try {
    const status = await api.availability({ sourceLanguage, targetLanguage });
    if (status === 'unavailable' || status === 'no') return null;
    return createNow(sourceLanguage, targetLanguage);
  } catch {
    return null;
  }
}

function createDetectorNow(): Promise<ChromeLanguageDetector | null> {
  if (detectorPromise) return detectorPromise;
  const api = detectorFactory();
  if (!api) return Promise.resolve(null);
  detectorPromise = api.create({
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        const selected = currentLanguage();
        setStatus('downloading', selected, event.loaded);
      });
    },
  }).catch((error) => {
    detectorPromise = null;
    console.warn('Chrome language detection could not start:', (error as Error).message);
    return null;
  });
  return detectorPromise;
}

async function getDetector(): Promise<ChromeLanguageDetector | null> {
  if (detectorPromise) return detectorPromise;
  const api = detectorFactory();
  if (!api) return null;
  try {
    const status = await api.availability();
    if (status === 'unavailable' || status === 'no') return null;
    return createDetectorNow();
  } catch {
    return null;
  }
}

/**
 * Full model detection is reserved for the one sentence the user is actively
 * submitting. Running LanguageDetector over every label on every render was the
 * performance regression: it could start/download a model and then execute
 * hundreds of detections before the book felt usable.
 */
async function detectPromptLanguage(text: string): Promise<SupportedLanguage> {
  const heuristic = heuristicLanguage(text);
  if (heuristic === 'ar' || heuristic === 'fr' || text.trim().length < 8) return heuristic;

  const detector = await getDetector();
  if (!detector) return heuristic;
  try {
    const results = await detector.detect(text);
    const found = results.find((result) =>
      (result.detectedLanguage === 'en' || result.detectedLanguage === 'fr' || result.detectedLanguage === 'ar')
      && result.confidence >= 0.45);
    return (found?.detectedLanguage as SupportedLanguage | undefined) ?? heuristic;
  } catch {
    return heuristic;
  }
}

async function translateOne(
  text: string,
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<string | null> {
  if (sourceLanguage === targetLanguage) return text;

  const direct = await getTranslator(sourceLanguage, targetLanguage);
  if (direct) {
    try { return await direct.translate(text); }
    catch { /* pivot below */ }
  }

  // Some Chrome installations expose language packs through English rather than
  // a direct FR↔AR pair. Pivoting keeps all three directions working locally.
  if (sourceLanguage !== 'en' && targetLanguage !== 'en') {
    const toEnglish = await getTranslator(sourceLanguage, 'en');
    const fromEnglish = await getTranslator('en', targetLanguage);
    if (toEnglish && fromEnglish) {
      try { return await fromEnglish.translate(await toEnglish.translate(text)); }
      catch { /* unavailable below */ }
    }
  }
  return null;
}

async function translateInChrome(targetLanguage: SupportedLanguage, texts: string[]) {
  if (!translatorFactory()) return null;
  if (!texts.length) return { translations: [], succeeded: [] as boolean[] };

  // UI strings use the cheap deterministic detector. Arabic script is exact,
  // French bookkeeping vocabulary/accents are scored, and the app's own UI
  // defaults to English. This keeps normal page loads entirely off the heavier
  // LanguageDetector model.
  const sourceLanguages = texts.map(heuristicLanguage);
  if (sourceLanguages.every((source) => source === targetLanguage)) {
    return { translations: [...texts], succeeded: texts.map(() => true) };
  }

  setStatus('translating', targetLanguage);
  const translations = new Array<string>(texts.length);
  const succeeded = new Array<boolean>(texts.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= texts.length) return;
      const text = texts[index];
      const sourceLanguage = sourceLanguages[index];
      if (sourceLanguage === targetLanguage) {
        translations[index] = text;
        succeeded[index] = true;
        continue;
      }
      const translated = await translateOne(text, sourceLanguage, targetLanguage);
      translations[index] = translated ?? text;
      succeeded[index] = translated !== null;
    }
  };

  const workerCount = Math.min(DISPLAY_CONCURRENCY, texts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (succeeded.every(Boolean)) setStatus('ready', targetLanguage);
  else setStatus('unavailable', targetLanguage);
  return { translations, succeeded };
}

function currentLanguage(): SupportedLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved === 'fr' || saved === 'ar') return saved;
  } catch { /* default */ }
  return 'en';
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return new URL(input, window.location.origin);
  if (input instanceof URL) return new URL(input.toString(), window.location.origin);
  return new URL(input.url, window.location.origin);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  if (input instanceof Request) return input.clone().json();
  return null;
}

function isLanguage(value: unknown): value is SupportedLanguage {
  return value === 'en' || value === 'fr' || value === 'ar';
}

function rememberCatalog(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const book = payload as Record<string, unknown>;
  const names = ['businesses', 'accounts', 'projects', 'people'].flatMap((key) => {
    const rows = book[key];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const name = (row as Record<string, unknown>).name;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    });
  });
  catalogNames = [...new Set(names)].sort((a, b) => b.length - a.length);
}

async function serverTranslate(targetLanguage: SupportedLanguage, texts: string[]) {
  try {
    const response = await nativeFetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language: targetLanguage, texts }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { translations?: unknown; available?: unknown };
    if (!Array.isArray(data.translations) || data.translations.length !== texts.length
      || data.translations.some((value) => typeof value !== 'string')) return null;
    return { translations: data.translations as string[], available: data.available !== false };
  } catch {
    return null;
  }
}

async function translateForDisplay(targetLanguage: SupportedLanguage, texts: string[]) {
  const local = await translateInChrome(targetLanguage, texts);
  if (!local) return null;
  if (local.succeeded.every(Boolean)) {
    return { translations: local.translations, available: true, provider: 'chrome' as const };
  }

  // Optional server fallback only fills the strings Chrome could not translate;
  // successfully translated local strings are never thrown away.
  const server = await serverTranslate(targetLanguage, texts);
  if (!server) {
    return { translations: local.translations, available: false, provider: 'chrome' as const };
  }
  const merged = local.translations.map((value, index) =>
    local.succeeded[index] ? value : server.translations[index] ?? value);
  return {
    translations: merged,
    available: local.succeeded.every((ok) => ok || server.available),
    provider: local.succeeded.every(Boolean) ? 'chrome' as const : 'mixed' as const,
  };
}

async function normalisePromptToEnglish(text: string) {
  const sourceLanguage = await detectPromptLanguage(text);
  if (sourceLanguage === 'en') return { text, sourceLanguage };

  const protectedText = protectTranslationText(text, catalogNames);
  let translated = await translateOne(protectedText.masked, sourceLanguage, 'en');
  if (!translated) {
    const fallback = await serverTranslate('en', [protectedText.masked]);
    translated = fallback?.translations[0] ?? null;
  }
  if (!translated) return { text, sourceLanguage };
  return { text: restoreTranslationText(translated, protectedText), sourceLanguage };
}

function jsonResponse(payload: unknown, original: Response) {
  const headers = new Headers(original.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function persistLanguage(language: SupportedLanguage) {
  try {
    await nativeFetch('/api/preferences/language', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language }),
    });
  } catch { /* local language still works */ }
}

function applySavedUserLanguage(language: SupportedLanguage) {
  const current = currentLanguage();
  if (current === language) return;
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* local preference can remain */ }

  // Reuse the real React language button instead of reloading the entire app.
  // The old implementation issued a second /api/me request and then did a full
  // window.reload(), which doubled startup work and made a language mismatch
  // look like a slow application boot.
  window.setTimeout(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.language-switch button')]
      .find((candidate) => candidate.textContent?.trim().toLowerCase() === language);
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
  }, 0);
}

function warmForTarget(targetLanguage: SupportedLanguage) {
  // Do not warm LanguageDetector here. It is only needed for an ambiguous prompt
  // and can be loaded lazily when the user actually submits one.
  if (targetLanguage === 'en') {
    void createNow('fr', 'en');
    void createNow('ar', 'en');
    return;
  }
  // Warm the normal English UI pair plus the non-English→English pivot needed
  // when saved text was originally entered in the third language.
  void createNow('en', targetLanguage);
  const third: SupportedLanguage = targetLanguage === 'fr' ? 'ar' : 'fr';
  void createNow(third, 'en');
}

// Start language-pack downloads from the actual click event. This preserves the
// user activation Chrome may require on first use, and saves the preference per
// signed-in user so another device starts in the same language.
document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target.closest('.language-switch button') : null;
  const picked = element?.textContent?.trim().toLowerCase();
  if (!isLanguage(picked)) return;
  warmForTarget(picked);
  void persistLanguage(picked);
}, true);

// The existing i18n layer sends every visible string through /api/translate.
// This wrapper upgrades that one route to true EN↔FR↔AR translation, captures
// catalog names for prompt protection, and normalises French/Arabic prompt input
// to English before the deterministic financial parser sees it.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: URL;
  try { url = requestUrl(input); }
  catch { return nativeFetch(input, init); }

  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin !== window.location.origin) return nativeFetch(input, init);

  // Piggyback the language preference on the app's existing /api/me request.
  // This removes the duplicate startup request and the forced full-page reload.
  if (url.pathname === '/api/me' && method === 'GET') {
    const response = await nativeFetch(input, init);
    if (response.ok) {
      try {
        const data = await response.clone().json() as { user?: { language?: unknown } | null };
        const language = data.user?.language;
        if (isLanguage(language)) applySavedUserLanguage(language);
      } catch { /* keep the local preference */ }
    }
    return response;
  }

  // Both the legacy full-book load and Phase 7's compact startup overview carry
  // the catalogs needed to protect account/business/person/project names in prompts.
  if ((url.pathname === '/api/book' || url.pathname === '/api/overview') && method === 'GET') {
    const response = await nativeFetch(input, init);
    if (response.ok) {
      try { rememberCatalog(await response.clone().json()); } catch { /* keep old catalog */ }
    }
    return response;
  }

  if (url.pathname === '/api/translate' && method === 'POST') {
    try {
      const body = await requestBody(input, init) as { language?: unknown; texts?: unknown } | null;
      if (!body || !isLanguage(body.language) || !Array.isArray(body.texts)
        || body.texts.some((text) => typeof text !== 'string')) {
        return nativeFetch(input, init);
      }
      const translated = await translateForDisplay(body.language, body.texts as string[]);
      if (!translated) return nativeFetch(input, init);
      return new Response(JSON.stringify(translated), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch {
      return nativeFetch(input, init);
    }
  }

  if (url.pathname === '/api/read' && method === 'POST' && typeof input !== 'object') {
    try {
      const body = await requestBody(input, init) as { text?: unknown; today?: unknown } | null;
      if (!body || typeof body.text !== 'string') return nativeFetch(input, init);
      const originalText = body.text;
      const prepared = await normalisePromptToEnglish(originalText);
      const response = await nativeFetch(input, {
        ...init,
        body: JSON.stringify({ ...body, text: prepared.text }),
      });
      if (!response.ok) return response;

      const data = await response.clone().json() as {
        draft?: { mode?: unknown; input?: { raw?: string }; raw?: string };
      };
      if (data.draft?.mode === 'entry' && data.draft.input) data.draft.input.raw = originalText;
      else if (data.draft?.mode === 'setup') data.draft.raw = originalText;
      return jsonResponse(data, response);
    } catch {
      return nativeFetch(input, init);
    }
  }

  return nativeFetch(input, init);
}) as typeof window.fetch;
