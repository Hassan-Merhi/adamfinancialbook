export type SupportedLanguage = 'en' | 'fr' | 'ar';

const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u;
const FRENCH_ACCENTS = /[àâçéèêëîïôùûüÿœæ]/giu;

const FRENCH_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'dans', 'sur', 'avec', 'sans', 'pour', 'par',
  'et', 'ou', 'est', 'sont', 'ai', 'acheté', 'achete', 'payé', 'paye', 'reçu', 'recu', 'envoyé', 'envoye',
  'transféré', 'transfere', 'déplacé', 'deplace', 'compte', 'caisse', 'espèces', 'especes', 'argent',
  'aujourd', 'hier', 'fournisseur', 'projet', 'entreprise', 'salaire', 'prêt', 'pret', 'dépense', 'depense',
  'ajouter', 'ajoute', 'créer', 'creer', 'vers', 'depuis', 'sous', 'chez', 'tonne', 'tonnes',
]);

const ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'from', 'to', 'with', 'for', 'and', 'or', 'is', 'are', 'i', 'bought', 'paid',
  'received', 'sent', 'moved', 'transfer', 'account', 'cash', 'money', 'today', 'yesterday', 'supplier',
  'project', 'business', 'salary', 'loan', 'expense', 'add', 'create', 'under', 'into', 'ton', 'tons',
]);

/** Cheap deterministic language guess used before an optional browser model is available. */
export function heuristicLanguage(text: string): SupportedLanguage {
  if (ARABIC.test(text)) return 'ar';
  const words = text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
  let fr = (text.match(FRENCH_ACCENTS) ?? []).length * 2;
  let en = 0;
  for (const word of words) {
    if (FRENCH_WORDS.has(word)) fr += 1;
    if (ENGLISH_WORDS.has(word)) en += 1;
  }
  return fr > en + 1 ? 'fr' : 'en';
}

export interface ProtectedTranslationText {
  masked: string;
  tokens: Array<{ token: string; value: string }>;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keep ledger identity and financial literals out of machine translation.
 * Translation providers only see marker tokens such as ⟦0⟧, so stored names,
 * amounts, dates, percentages, references and filenames come back byte-for-byte.
 */
export function protectTranslationText(text: string, names: string[] = []): ProtectedTranslationText {
  let masked = text;
  const tokens: Array<{ token: string; value: string }> = [];
  const protectedValues = new Set<string>();

  const protect = (value: string) => {
    const clean = value.trim();
    const key = clean.toLocaleLowerCase();
    if (!clean || protectedValues.has(key)) return;
    protectedValues.add(key);
    const token = `⟦${tokens.length}⟧`;
    tokens.push({ token, value: clean });
    masked = masked.replace(new RegExp(escapeRegExp(clean), 'giu'), token);
  };

  [...names]
    .filter((name) => name.trim().length >= 2)
    .sort((a, b) => b.length - a.length)
    .forEach(protect);

  // Deliberately quoted user text is treated as a literal.
  for (const match of text.matchAll(/["'“”«»]([^"'“”«»]{2,120})["'“”«»]/gu)) {
    if (match[1]) protect(match[1]);
  }

  // Protect URLs and email addresses before shorter token patterns.
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/giu)) protect(match[0]);
  for (const match of text.matchAll(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu)) protect(match[0]);

  // Filenames and common document/image evidence references.
  for (const match of text.matchAll(/\b[^\s/\\]+\.(?:pdf|png|jpe?g|webp|gif|csv|xlsx?|docx?)\b/giu)) protect(match[0]);

  // Opaque business/account/reference codes should never be translated.
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_-]{1,32}\b/g)) protect(match[0]);

  // Dates, currency amounts, percentages and standalone numeric quantities keep
  // their original decimal separators and symbols. Do this after names/codes so
  // a number embedded inside a protected identifier does not become a new token.
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) protect(match[0]);
  for (const match of text.matchAll(/(?:USD|EUR|GBP|ZAR|CDF|[$€£])\s?\d[\d,.]*(?:\s?(?:USD|EUR|GBP|ZAR|CDF))?/giu)) protect(match[0]);
  for (const match of text.matchAll(/\b\d[\d,.]*%\b/g)) protect(match[0]);
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) protect(match[0]);

  return { masked, tokens };
}

export function restoreTranslationText(text: string, protectedText: ProtectedTranslationText): string {
  let restored = text;
  for (const { token, value } of protectedText.tokens) restored = restored.split(token).join(value);
  return restored;
}
