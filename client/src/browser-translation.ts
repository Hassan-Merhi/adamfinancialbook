type BookLanguage = 'en' | 'fr' | 'ar';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

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

const nativeFetch = window.fetch.bind(window);
const translatorPromises = new Map<string, Promise<ChromeTranslator | null>>();

function factory(): TranslatorFactory | null {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator ?? null;
}

function key(targetLanguage: BookLanguage) {
  return `en>${targetLanguage}`;
}

function createNow(targetLanguage: Exclude<BookLanguage, 'en'>): Promise<ChromeTranslator | null> {
  const api = factory();
  if (!api) return Promise.resolve(null);

  const existing = translatorPromises.get(key(targetLanguage));
  if (existing) return existing;

  // Calling create() directly from the language-button click is deliberate.
  // Chrome may require that user activation to download a language pack.
  const pending = api.create({
    sourceLanguage: 'en',
    targetLanguage,
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        document.documentElement.style.setProperty('--translation-download', String(event.loaded));
      });
    },
  }).catch((error) => {
    translatorPromises.delete(key(targetLanguage));
    console.warn('Chrome translation could not start:', (error as Error).message);
    return null;
  });

  translatorPromises.set(key(targetLanguage), pending);
  return pending;
}

async function getTranslator(targetLanguage: Exclude<BookLanguage, 'en'>): Promise<ChromeTranslator | null> {
  const existing = translatorPromises.get(key(targetLanguage));
  if (existing) return existing;

  const api = factory();
  if (!api) return null;

  try {
    const status = await api.availability({ sourceLanguage: 'en', targetLanguage });
    if (status !== 'available') return null;
    return createNow(targetLanguage);
  } catch {
    return null;
  }
}

async function translateInChrome(language: BookLanguage, texts: string[]): Promise<string[] | null> {
  // The app stores original display text in English, so switching back to EN
  // means showing that original instead of spending work translating it again.
  if (language === 'en') return [...texts];

  const translator = await getTranslator(language);
  if (!translator) return null;

  try {
    // Chrome processes one translator sequentially. Keeping the loop explicit
    // avoids flooding its queue and still lets the app batch DOM strings.
    const translated: string[] = [];
    for (const text of texts) translated.push(await translator.translate(text));
    return translated;
  } catch (error) {
    console.warn('Chrome translation failed, trying the server fallback:', (error as Error).message);
    return null;
  }
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

function isLanguage(value: unknown): value is BookLanguage {
  return value === 'en' || value === 'fr' || value === 'ar';
}

// Warm the requested Chrome language pack from the actual click event. This is
// the user activation Chrome needs the first time a language pack is downloaded.
document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target.closest('.language-switch button') : null;
  const picked = element?.textContent?.trim().toLowerCase();
  if (picked === 'fr' || picked === 'ar') void createNow(picked);
}, true);

// The existing i18n layer already sends every visible string through
// /api/translate. Intercept only that request and satisfy it locally in Chrome.
// If Chrome does not support the API (for example on mobile), the request falls
// through unchanged to the existing optional server translator.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: URL;
  try { url = requestUrl(input); }
  catch { return nativeFetch(input, init); }

  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin !== window.location.origin || url.pathname !== '/api/translate' || method !== 'POST') {
    return nativeFetch(input, init);
  }

  try {
    const body = await requestBody(input, init) as { language?: unknown; texts?: unknown } | null;
    if (!body || !isLanguage(body.language) || !Array.isArray(body.texts)
      || body.texts.some((text) => typeof text !== 'string')) {
      return nativeFetch(input, init);
    }

    const translations = await translateInChrome(body.language, body.texts as string[]);
    if (!translations) return nativeFetch(input, init);

    return new Response(JSON.stringify({ translations, available: true, provider: 'chrome' }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return nativeFetch(input, init);
  }
}) as typeof window.fetch;
