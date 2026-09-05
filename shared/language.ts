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

/**
 * Cheap deterministic language guess used when Chrome's LanguageDetector is not
 * available yet. Arabic script is unambiguous; Latin text is scored from common
 * bookkeeping words and French diacritics. Unknown Latin prose defaults to EN,
 * which is the app's source language.
 */
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
 * Keep ledger vocabulary and obvious identifiers out of machine translation.
 * The translator only sees numeric marker tokens such as ⟦0⟧, which keeps exact
 * account/business/person/project names stable for the parser.
 */
export function protectTranslationText(text: string, names: string[] = []): ProtectedTranslationText {
  let masked = text;
  const tokens: Array<{ token: string; value: string }> = [];
  const protectedValues = new Set<string>();

  const protect = (value: string) => {
    const clean = value.trim();
    if (!clean || protectedValues.has(clean.toLocaleLowerCase())) return;
    protectedValues.add(clean.toLocaleLowerCase());
    const token = `⟦${tokens.length}⟧`;
    tokens.push({ token, value: clean });
    masked = masked.replace(new RegExp(escapeRegExp(clean), 'giu'), token);
  };

  [...names]
    .filter((name) => name.trim().length >= 2)
    .sort((a, b) => b.length - a.length)
    .forEach(protect);

  // Quoted names/comments are deliberate user text. Preserve them exactly.
  for (const match of text.matchAll(/["'“”«»]([^"'“”«»]{2,80})["'“”«»]/gu)) {
    if (match[1]) protect(match[1]);
  }

  // Opaque business/account codes should never be translated.
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_-]{1,24}\b/g)) protect(match[0]);

  return { masked, tokens };
}

export function restoreTranslationText(text: string, protectedText: ProtectedTranslationText): string {
  let restored = text;
  for (const { token, value } of protectedText.tokens) {
    restored = restored.split(token).join(value);
  }
  return restored;
}
