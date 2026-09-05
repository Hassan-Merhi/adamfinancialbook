import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: pg.Client | null = null;
let translateTexts: typeof import('./translate.js').translateTexts;
const oldKey = process.env.GOOGLE_TRANSLATE_API_KEY;

function digest(sourceLanguage: string | undefined, text: string) {
  return createHash('sha256').update(`${sourceLanguage ?? 'auto'}\u0000${text}`, 'utf8').digest('hex');
}

describe.skipIf(!DATABASE_URL)('Phase 8 durable translation cache', () => {
  beforeAll(async () => {
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
    client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS translation_cache');
    ({ translateTexts } = await import('./translate.js'));
  });

  afterAll(async () => {
    if (oldKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = oldKey;
    await client?.end();
  });

  it('keeps English identity work provider-free', async () => {
    await expect(translateTexts('en', ['Cash on hand']))
      .resolves.toEqual({ translations: ['Cash on hand'], available: true });
  });

  it('self-creates the cache and safely falls back to original text without a provider', async () => {
    const answer = await translateTexts('fr', ['uncached dynamic note']);
    expect(answer).toEqual({ translations: ['uncached dynamic note'], available: false });
    const table = await client!.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'translation_cache'`,
    );
    expect(table.rows.map((row) => row.name)).toEqual(['translation_cache']);
  });

  it('serves a durable database hit without contacting an external provider', async () => {
    const source = 'dynamic supplier note';
    const translated = 'note fournisseur dynamique';
    await client!.query(
      `INSERT INTO translation_cache
        (language, source_language, source_hash, source_text, translated_text, provider)
       VALUES ('fr', NULL, $1, $2, $3, 'google')`,
      [digest(undefined, source), source, translated],
    );

    const answer = await translateTexts('fr', [source]);
    expect(answer).toEqual({ translations: [translated], available: true, provider: 'cache' });
  });
});
