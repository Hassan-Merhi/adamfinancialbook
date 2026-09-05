import { read as readWithRules } from '../../shared/parse';
import { heuristicLanguage, protectTranslationText, restoreTranslationText, type SupportedLanguage } from '../../shared/language';
import type { Book } from '../../shared/types';

interface ChromeTranslator {
  translate(text: string): Promise<string>;
}

interface TranslatorFactory {
  availability?: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}

const previousFetch = window.fetch.bind(window);
const promptTranslators = new Map<string, Promise<ChromeTranslator | null>>();

function factory(): TranslatorFactory | null {
  return (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator ?? null;
}

function isLanguage(value: unknown): value is SupportedLanguage {
  return value === 'en' || value === 'fr' || value === 'ar';
}

function translator(source: Exclude<SupportedLanguage, 'en'>) {
  const key = `${source}>en`;
  const existing = promptTranslators.get(key);
  if (existing) return existing;
  const api = factory();
  if (!api) return Promise.resolve(null);
  const pending = (async () => {
    try {
      if (api.availability) {
        const status = await api.availability({ sourceLanguage: source, targetLanguage: 'en' });
        if (status === 'unavailable' || status === 'no') return null;
      }
      return await api.create({ sourceLanguage: source, targetLanguage: 'en' });
    } catch {
      promptTranslators.delete(key);
      return null;
    }
  })();
  promptTranslators.set(key, pending);
  return pending;
}

function warmPromptPack(language: SupportedLanguage) {
  if (language === 'fr' || language === 'ar') void translator(language);
}

window.addEventListener('book:language-change', (event) => {
  const language = (event as CustomEvent<unknown>).detail;
  if (isLanguage(language)) warmPromptPack(language);
});

function snapshot(): (Book & { balances?: unknown }) | null {
  try {
    const raw = localStorage.getItem('book.snapshot');
    return raw ? JSON.parse(raw) as Book & { balances?: unknown } : null;
  } catch {
    return null;
  }
}

function names(book: Book | null) {
  if (!book) return [];
  return [
    ...book.businesses.map((row) => row.name),
    ...book.accounts.map((row) => row.name),
    ...book.projects.map((row) => row.name),
    ...book.people.map((row) => row.name),
  ];
}

async function serverToEnglish(masked: string, source: Exclude<SupportedLanguage, 'en'>): Promise<string | null> {
  if (!navigator.onLine) return null;
  try {
    const response = await previousFetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language: 'en', sourceLanguage: source, texts: [masked] }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { translations?: unknown; available?: unknown };
    if (data.available === false || !Array.isArray(data.translations) || typeof data.translations[0] !== 'string') return null;
    return data.translations[0];
  } catch {
    return null;
  }
}

async function toEnglish(text: string, book: Book | null) {
  const source = heuristicLanguage(text);
  if (source === 'en') return text;
  const protectedText = protectTranslationText(text, names(book));
  const engine = await translator(source);
  if (engine) {
    try { return restoreTranslationText(await engine.translate(protectedText.masked), protectedText); }
    catch { /* provider fallback below */ }
  }
  const server = await serverToEnglish(protectedText.masked, source);
  return server ? restoreTranslationText(server, protectedText) : text;
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return new URL(input, window.location.origin);
  if (input instanceof URL) return new URL(input.toString(), window.location.origin);
  return new URL(input.url, window.location.origin);
}

async function requestJson(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof init?.body === 'string') return JSON.parse(init.body) as Record<string, unknown>;
  if (input instanceof Request) return await input.clone().json() as Record<string, unknown>;
  return null;
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

async function syncLanguageAfterLogin() {
  try {
    const response = await previousFetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json() as { user?: { language?: unknown } | null };
    const language = data.user?.language;
    if (!isLanguage(language)) return;
    try { localStorage.setItem('book.language', language); } catch { /* in-memory state can still adopt */ }
    window.dispatchEvent(new CustomEvent('book:language-preference', { detail: language }));
  } catch { /* login still succeeded */ }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: URL;
  try { url = requestUrl(input); }
  catch { return previousFetch(input, init); }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (url.origin === window.location.origin && url.pathname === '/api/read' && method === 'POST') {
    try {
      const body = await requestJson(input, init);
      const original = body?.text;
      const book = snapshot();
      if (typeof original === 'string') {
        const normalized = await toEnglish(original, book);
        const today = typeof body?.today === 'string' ? body.today : new Date().toISOString().slice(0, 10);

        if (!navigator.onLine && book) {
          const draft = readWithRules(normalized, book, today);
          if (draft.mode === 'entry') draft.input.raw = original;
          else draft.raw = original;
          return new Response(JSON.stringify({ draft, source: 'rules', duplicate: null }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }

        const response = await previousFetch(input, {
          ...init,
          headers: init?.headers,
          body: JSON.stringify({ ...body, text: normalized }),
        });
        if (!response.ok || normalized === original) return response;
        try {
          const data = await response.clone().json() as {
            draft?: { mode?: unknown; input?: { raw?: string }; raw?: string };
          };
          if (data.draft?.mode === 'entry' && data.draft.input) data.draft.input.raw = original;
          else if (data.draft?.mode === 'setup') data.draft.raw = original;
          return jsonResponse(data, response);
        } catch {
          return response;
        }
      }
    } catch { /* normal request/error path below */ }
  }

  const response = await previousFetch(input, init);
  if (response.ok && url.origin === window.location.origin
      && (url.pathname === '/api/login' || url.pathname === '/api/first-owner') && method === 'POST') {
    window.setTimeout(() => { void syncLanguageAfterLogin(); }, 0);
  }
  return response;
}) as typeof window.fetch;
