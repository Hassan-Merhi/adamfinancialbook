import Anthropic from '@anthropic-ai/sdk';

export type BookLanguage = 'en' | 'fr' | 'ar';

const LANGUAGE_NAMES: Record<BookLanguage, string> = {
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
};

// Google Cloud Translation is the primary provider for the global UI translator.
// It is purpose-built for this job and lets the client translate every visible
// string without maintaining a hand-written dictionary for every page.
const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

// Claude remains a fallback when it is already configured for sentence reading,
// so deployments do not suddenly lose translation while a Google key is being
// added. It can also be pointed at a cheaper model independently.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_TRANSLATION_MODEL ?? 'claude-opus-5';

const TRANSLATION_TOOL: Anthropic.Tool = {
  name: 'return_translations',
  description: 'Return exactly one translated string for every supplied string, in the same order.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      translations: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['translations'],
    additionalProperties: false,
  },
};

const SYSTEM = `You are the translation layer for a financial bookkeeping application.
Translate every supplied string into the requested target language and return only the tool result.

Rules:
- Preserve the exact financial meaning. Never add explanations, advice, or missing facts.
- Preserve numbers, currency amounts, dates, percentages, email addresses, URLs, identifiers, reference codes, and filenames exactly.
- Keep personal names, company/brand names, and opaque account codes unchanged. Ordinary descriptive account/project/business names may be translated naturally.
- Translate interface labels, transaction purposes, comments, notes, reminders, status messages, warnings, and ordinary prose naturally.
- A string already written in the requested language should be returned unchanged unless a tiny grammatical normalization is necessary.
- For Arabic use clear Modern Standard Arabic suitable for a business interface. Do not transliterate English words when a normal Arabic financial term exists.
- Keep each output concise and faithful to the corresponding input. The output array length must exactly equal the input array length.`;

// Server-side cache stops repeated provider calls across users while this process
// is alive. The browser has its own persistent cache as well.
const CACHE = new Map<string, string>();
const MAX_CACHE = 5_000;

function cacheKey(language: BookLanguage, text: string) {
  return `${language}\u0000${text}`;
}

function remember(key: string, value: string) {
  if (CACHE.has(key)) CACHE.delete(key);
  CACHE.set(key, value);
  if (CACHE.size > MAX_CACHE) {
    const oldest = CACHE.keys().next().value as string | undefined;
    if (oldest) CACHE.delete(oldest);
  }
}

function decodeGoogleText(value: string) {
  // The v2 API can entity-encode punctuation in translatedText. Decode the
  // small HTML entity set that can occur in ordinary bookkeeping/UI prose.
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function translateWithGoogle(language: BookLanguage, texts: string[]): Promise<string[] | null> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return null;

  const response = await fetch(`${GOOGLE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: texts, target: language, format: 'text' }),
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

  const translated = rows.map((row) => {
    if (typeof row.translatedText !== 'string') throw new Error('Google Translation returned an invalid string.');
    return decodeGoogleText(row.translatedText);
  });
  return translated;
}

async function translateWithAnthropic(language: BookLanguage, texts: string[]): Promise<string[] | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: Math.min(8_000, Math.max(1_000, texts.join('').length * 2)),
    system: SYSTEM,
    tools: [TRANSLATION_TOOL],
    tool_choice: { type: 'tool', name: 'return_translations' },
    messages: [{
      role: 'user',
      content: `Target language: ${LANGUAGE_NAMES[language]} (${language}).\n\nStrings to translate, as JSON:\n${JSON.stringify(texts)}`,
    }],
  });

  const call = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!call) throw new Error('The translation model returned no translation tool result.');

  const translated = (call.input as { translations?: unknown }).translations;
  if (!Array.isArray(translated) || translated.length !== texts.length || translated.some((v) => typeof v !== 'string')) {
    throw new Error('The translation model returned the wrong number of strings.');
  }
  return translated as string[];
}

export async function translateTexts(
  language: BookLanguage,
  texts: string[],
): Promise<{ translations: string[]; available: boolean; provider?: 'google' | 'anthropic' }> {
  if (!texts.length) return { translations: [], available: true };

  // English is the source UI language. No provider call is needed to switch back.
  if (language === 'en') return { translations: [...texts], available: true };

  const result = [...texts];
  const missing: string[] = [];
  const missingIndexes = new Map<string, number[]>();

  texts.forEach((text, index) => {
    const cached = CACHE.get(cacheKey(language, text));
    if (cached !== undefined) {
      result[index] = cached;
      return;
    }
    const indexes = missingIndexes.get(text);
    if (indexes) indexes.push(index);
    else {
      missing.push(text);
      missingIndexes.set(text, [index]);
    }
  });

  if (!missing.length) return { translations: result, available: true };

  let translated: string[] | null = null;
  let provider: 'google' | 'anthropic' | undefined;

  // Google is primary. If its key is absent or the API has a temporary problem,
  // try the already-supported Anthropic connection before showing source text.
  try {
    translated = await translateWithGoogle(language, missing);
    if (translated) provider = 'google';
  } catch (error) {
    console.warn('Google translation unavailable, trying fallback:', (error as Error).message);
  }

  if (!translated) {
    try {
      translated = await translateWithAnthropic(language, missing);
      if (translated) provider = 'anthropic';
    } catch (error) {
      console.warn('Anthropic translation unavailable:', (error as Error).message);
    }
  }

  if (!translated) return { translations: result, available: false };

  missing.forEach((source, i) => {
    const value = translated![i] ?? source;
    remember(cacheKey(language, source), value);
    for (const index of missingIndexes.get(source) ?? []) result[index] = value;
  });

  return { translations: result, available: true, provider };
}
