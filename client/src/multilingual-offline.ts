import { read as readWithRules } from '../../shared/parse';
import { heuristicLanguage, protectTranslationText, restoreTranslationText, type SupportedLanguage } from '../../shared/language';
import type { Book } from '../../shared/types';

interface ChromeTranslator {
  translate(text: string): Promise<string>;
}

interface TranslatorFactory {
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
  const pending = api.create({ sourceLanguage: source, targetLanguage: 'en' })
    .catch(() => null);
  promptTranslators.set(key, pending);
  return pending;
}

function warmPromptPacks() {
  // Prompt parsing always happens in English. Starting these from the language
  // button click means French/Arabic prompts can still be read with no network
  // later, once Chrome has downloaded the packs.
  void translator('fr');
  void translator('ar');
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('.language-switch button') : null;
  if (button) warmPromptPacks();
}, true);

function snapshot(): (Book & { balances?: unknown }) | null {
  try {
    const raw = localStorage.getItem('book.snapshot');
    return raw ? JSON.parse(raw) as Book & { balances?: unknown } : null;
  } catch {
    return null;
  }
}

function names(book: Book) {
  return [
    ...book.businesses.map((row) => row.name),
    ...book.accounts.map((row) => row.name),
    ...book.projects.map((row) => row.name),
    ...book.people.map((row) => row.name),
  ];
}

async function toEnglish(text: string, book: Book) {
  const source = heuristicLanguage(text);
  if (source === 'en') return text;
  const protectedText = protectTranslationText(text, names(book));
  const engine = await translator(source);
  if (!engine) return text;
  try {
    return restoreTranslationText(await engine.translate(protectedText.masked), protectedText);
  } catch {
    return text;
  }
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

async function syncLanguageAfterLogin() {
  try {
    const response = await previousFetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json() as { user?: { language?: unknown } | null };
    const language = data.user?.language;
    if (!isLanguage(language)) return;
    const current = localStorage.getItem('book.language');
    if (current === language) return;
    localStorage.setItem('book.language', language);
    window.location.reload();
  } catch { /* login still succeeded; preference can sync on next load */ }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: URL;
  try { url = requestUrl(input); }
  catch { return previousFetch(input, init); }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  // The ordinary Entry component already supports offline logging. This branch
  // makes its reader multilingual too by running the same deterministic parser
  // against the last saved book after Chrome translates the command locally.
  if (!navigator.onLine && url.origin === window.location.origin
      && url.pathname === '/api/read' && method === 'POST') {
    try {
      const body = await requestJson(input, init);
      const original = body?.text;
      const book = snapshot();
      if (typeof original === 'string' && book) {
        const today = typeof body?.today === 'string' ? body.today : new Date().toISOString().slice(0, 10);
        const normalized = await toEnglish(original, book);
        const draft = readWithRules(normalized, book, today);
        if (draft.mode === 'entry') draft.input.raw = original;
        else draft.raw = original;
        return new Response(JSON.stringify({ draft, source: 'rules', duplicate: null }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    } catch { /* fall through to the normal offline error path */ }
  }

  const response = await previousFetch(input, init);
  if (response.ok && url.origin === window.location.origin
      && (url.pathname === '/api/login' || url.pathname === '/api/first-owner') && method === 'POST') {
    window.setTimeout(() => { void syncLanguageAfterLogin(); }, 0);
  }
  return response;
}) as typeof window.fetch;
