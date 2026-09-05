import Anthropic from '@anthropic-ai/sdk';

export type BookLanguage = 'en' | 'fr' | 'ar';

const LANGUAGE_NAMES: Record<BookLanguage, string> = {
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
};

// Reuse the model that already reads the bookkeeping prompt. Deployments can
// point translation at a cheaper model without changing code.
const MODEL = process.env.ANTHROPIC_TRANSLATION_MODEL ?? 'claude-opus-5';

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

// Server-side cache stops repeated model calls across users while this process is
// alive. The browser has its own persistent cache as well.
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

export async function translateTexts(
  language: BookLanguage,
  texts: string[],
): Promise<{ translations: string[]; available: boolean }> {
  if (!texts.length) return { translations: [], available: true };

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
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { translations: result, available: false };
  }

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: Math.min(8_000, Math.max(1_000, missing.join('').length * 2)),
      system: SYSTEM,
      tools: [TRANSLATION_TOOL],
      tool_choice: { type: 'tool', name: 'return_translations' },
      messages: [{
        role: 'user',
        content: `Target language: ${LANGUAGE_NAMES[language]} (${language}).\n\nStrings to translate, as JSON:\n${JSON.stringify(missing)}`,
      }],
    });

    const call = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (!call) throw new Error('The translation model returned no translation tool result.');

    const translated = (call.input as { translations?: unknown }).translations;
    if (!Array.isArray(translated) || translated.length !== missing.length || translated.some((v) => typeof v !== 'string')) {
      throw new Error('The translation model returned the wrong number of strings.');
    }

    missing.forEach((source, i) => {
      const value = translated[i] as string;
      remember(cacheKey(language, source), value);
      for (const index of missingIndexes.get(source) ?? []) result[index] = value;
    });

    return { translations: result, available: true };
  } catch (error) {
    console.warn('Translation unavailable, showing original text:', (error as Error).message);
    return { translations: result, available: false };
  }
}
