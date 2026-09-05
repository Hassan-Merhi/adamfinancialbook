import { createHash } from 'node:crypto';
import { query } from './db.js';

export type BookLanguage = 'en' | 'fr' | 'ar';

const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const MEMORY_CACHE = new Map<string, string>();
const MAX_MEMORY_CACHE = 2_000;

type Provider = 'google';
type CacheRow = { source_hash: string; source_text: string; translated_text: string };

function digest(sourceLanguage: BookLanguage | undefined, text: string) {
  return createHash('sha256').update(`${sourceLanguage ?? 'auto'}\u0000${text}`, 'utf8').digest('hex');
}

function memoryKey(language: BookLanguage, sourceLanguage: BookLanguage | undefined, text: string) {
  return `${language}\u0000${sourceLanguage ?? 'auto'}\u0000${text}`;
}

function rememberMemory(key: string, value: string) {
  if (MEMORY_CACHE.has(key)) MEMORY_CACHE.delete(key);
  MEMORY_CACHE.set(key, value);
  if (MEMORY_CACHE.size > MAX_MEMORY_CACHE) {
    const oldest = MEMORY_CACHE.keys().next().value as string | undefined;
    if (oldest) MEMORY_CACHE.delete(oldest);
  }
}

function decodeGoogleText(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function translateWithGoogle(
  language: BookLanguage,
  texts: string[],
  sourceLanguage?: BookLanguage,
): Promise<string[] | null> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return null;

  const response = await fetch(`${GOOGLE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      q: texts,
      target: language,
      ...(sourceLanguage ? { source: sourceLanguage } : {}),
      format: 'text',
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`Google Translation returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const payload = await response.json() as {
    data?: { translations?: Array<{ translatedText?: unknown }> };
  };
  const rows = payload.data?.translations;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error('Google Translation returned the wrong number of strings.');
  }
  return rows.map((row) => {
    if (typeof row.translatedText !== 'string') throw new Error('Google Translation returned an invalid string.');
    return decodeGoogleText(row.translatedText);
  });
}

async function durableHits(
  language: BookLanguage,
  sourceLanguage: BookLanguage | undefined,
  texts: string[],
): Promise<Map<string, string>> {
  const hashes = texts.map((text) => digest(sourceLanguage, text));
  if (!hashes.length) return new Map();
  const rows = await query<CacheRow>(
    `SELECT source_hash, source_text, translated_text
       FROM translation_cache
      WHERE language = $1 AND source_hash = ANY($2::text[])`,
    [language, hashes],
  );
  const byHash = new Map(rows.map((row) => [row.source_hash, row]));
  const result = new Map<string, string>();
  texts.forEach((text) => {
    const row = byHash.get(digest(sourceLanguage, text));
    // Hash collisions are extraordinarily unlikely, but checking the stored
    // source makes cache correctness independent of that assumption.
    if (row?.source_text === text) result.set(text, row.translated_text);
  });
  return result;
}

async function rememberDurable(
  language: BookLanguage,
  sourceLanguage: BookLanguage | undefined,
  source: string,
  translated: string,
  provider: Provider,
) {
  await query(
    `INSERT INTO translation_cache
       (language, source_language, source_hash, source_text, translated_text, provider, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (language, source_hash) DO UPDATE SET
       source_language = EXCLUDED.source_language,
       source_text = EXCLUDED.source_text,
       translated_text = EXCLUDED.translated_text,
       provider = EXCLUDED.provider,
       updated_at = now()`,
    [language, sourceLanguage ?? null, digest(sourceLanguage, source), source, translated, provider],
  );
}

export async function translateTexts(
  language: BookLanguage,
  texts: string[],
  sourceLanguage?: BookLanguage,
): Promise<{ translations: string[]; available: boolean; provider?: Provider | 'cache' }> {
  if (!texts.length) return { translations: [], available: true };
  if (sourceLanguage === language || (language === 'en' && !sourceLanguage)) {
    return { translations: [...texts], available: true };
  }

  const result = [...texts];
  const missing: string[] = [];
  const missingIndexes = new Map<string, number[]>();

  const unresolved = texts.filter((text) => MEMORY_CACHE.get(memoryKey(language, sourceLanguage, text)) === undefined);
  let durable = new Map<string, string>();
  if (unresolved.length) {
    try { durable = await durableHits(language, sourceLanguage, [...new Set(unresolved)]); }
    catch (error) { console.warn('Translation cache read unavailable:', (error as Error).message); }
  }

  texts.forEach((text, index) => {
    const key = memoryKey(language, sourceLanguage, text);
    const memory = MEMORY_CACHE.get(key);
    if (memory !== undefined) { result[index] = memory; return; }
    const stored = durable.get(text);
    if (stored !== undefined) {
      result[index] = stored;
      rememberMemory(key, stored);
      return;
    }
    const indexes = missingIndexes.get(text);
    if (indexes) indexes.push(index);
    else {
      missing.push(text);
      missingIndexes.set(text, [index]);
    }
  });

  if (!missing.length) return { translations: result, available: true, provider: 'cache' };

  let translated: string[] | null = null;
  try {
    translated = await translateWithGoogle(language, missing, sourceLanguage);
  } catch (error) {
    console.warn('Google translation unavailable:', (error as Error).message);
  }
  if (!translated) return { translations: result, available: false };

  await Promise.all(missing.map(async (source, index) => {
    const value = translated![index] ?? source;
    rememberMemory(memoryKey(language, sourceLanguage, source), value);
    for (const itemIndex of missingIndexes.get(source) ?? []) result[itemIndex] = value;
    try { await rememberDurable(language, sourceLanguage, source, value, 'google'); }
    catch (error) { console.warn('Translation cache write unavailable:', (error as Error).message); }
  }));

  return { translations: result, available: true, provider: 'google' };
}
