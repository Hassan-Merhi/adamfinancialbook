/**
 * Reading a sentence the way it was said.
 *
 * This is the deterministic reader: it works with no API key, no network, and
 * no cost, and it is what the LLM reader falls back to. Both produce the same
 * kind of draft, and a draft is only ever a proposal — nothing reaches the book
 * until it has been confirmed on screen.
 */

import type { Catalog, EntryInput, EntryKind, Id } from './types.js';

export interface EntryDraft {
  mode: 'entry';
  input: EntryInput;
  /** "1 ton", when a number turned out to be a quantity rather than a price. */
  quantity?: string;
  /** Fields the sentence did not settle: 'amount' | 'account' | 'person' | 'project'. */
  needs: string[];
  /** Fields filled in by assumption — the screen highlights these. */
  guessed: string[];
}

export type SetupKind = 'business' | 'account' | 'project' | 'payroll' | 'supplier' | 'lender';

export interface SetupDraft {
  mode: 'setup';
  kind: SetupKind;
  name: string;
  businessId: Id | null;
  amount: number;
  raw: string;
  needs: string[];
}

export type Draft = EntryDraft | SetupDraft;

/* ------------------------------------------------------------------ *
 * Vocabulary — built from the book itself, so it grows as the book does
 * ------------------------------------------------------------------ */

type Hit = { kind: 'account' | 'project' | 'person' | 'business'; id: Id; at: number; len: number };

function vocabulary(catalog: Catalog) {
  const words: { kind: Hit['kind']; id: Id; phrase: string }[] = [];
  const add = (kind: Hit['kind'], id: Id, name: string) => {
    const full = name.toLowerCase().trim();
    words.push({ kind, id, phrase: full });
    const first = full.split(/[\s—-]+/)[0];
    // a distinctive first word is how people actually refer to things
    if (first && first.length > 3 && first !== full) words.push({ kind, id, phrase: first });
  };
  catalog.accounts.forEach((a) => add('account', a.id, a.name));
  catalog.projects.forEach((p) => add('project', p.id, p.name));
  catalog.people.forEach((p) => add('person', p.id, p.name));
  catalog.businesses.forEach((b) => add('business', b.id, b.name));
  return words.sort((a, b) => b.phrase.length - a.phrase.length);
}

function findAll(text: string, catalog: Catalog): Hit[] {
  const hay = ` ${text.toLowerCase()} `;
  const found: Hit[] = [];
  const taken: [number, number][] = [];
  for (const w of vocabulary(catalog)) {
    const at = hay.indexOf(` ${w.phrase}`);
    if (at < 0) continue;
    const end = at + w.phrase.length + 1;
    // a longer name already claimed these characters
    if (taken.some(([s, e]) => at < e && end > s)) continue;
    if (found.some((f) => f.kind === w.kind && f.id === w.id)) continue;
    taken.push([at, end]);
    found.push({ kind: w.kind, id: w.id, at, len: w.phrase.length });
  }
  return found.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ *
 * Amounts, dates
 * ------------------------------------------------------------------ */

const UNITS = /^(tons?|tonnes?|kgs?|kg|bags?|sacs?|sacks?|pcs|pieces?|boxes|units?|litres?|liters?|m3|cbm|containers?|rolls?|sheets?|trucks?|loads?|men|workers?|days?|months?)$/;

/** A price, not a quantity: "1 ton of bricks for $1000" is $1,000, not $1. */
export function readAmount(text: string): { amount: number; quantity?: string } {
  const cleaned = text.replace(/,(?=\d{3}\b)/g, '');
  const re = /(\$)?(\d+(?:\.\d+)?)\s*(k\b)?\s*([a-z]+)?/gi;
  let best: { value: number; score: number } | null = null;
  let quantity: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const unit = m[4]?.toLowerCase();
    const isQuantity = !!unit && UNITS.test(unit);
    const value = parseFloat(m[2]) * (m[3] ? 1000 : 1);
    let score = Math.min(value, 100_000) / 1000;
    if (m[1]) score += 1000;          // written with a $
    if (m[3]) score += 400;           // written as 12k
    if (isQuantity) { score -= 900; quantity = `${m[2]} ${unit}`; }
    if (!best || score > best.score) best = { value, score };
  }
  if (!best || best.score < 0) return { amount: 0, quantity };
  return { amount: best.value, quantity };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function readDate(text: string, today: string): { date: string; historical: boolean } {
  const t = text.toLowerCase();

  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return { date: `${year}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`, historical: true };
  }

  if (/\byesterday\b/.test(t)) return { date: shift(today, -1), historical: false };
  if (/\bday before yesterday\b/.test(t)) return { date: shift(today, -2), historical: false };

  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(t));
  if (month >= 0) {
    const day = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTHS[month]}|${MONTHS[month]}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
    const dd = day ? (day[1] ?? day[2] ?? '15') : '15';
    const year = Number(today.slice(0, 4));
    // a month later in the year than today means last year
    const candidate = `${year}-${String(month + 1).padStart(2, '0')}-${dd.padStart(2, '0')}`;
    return { date: candidate > today ? `${year - 1}${candidate.slice(4)}` : candidate, historical: true };
  }

  const past = /\bback in\b|\bpreviously\b|\blast month\b|\bearlier\b|\bhistorical\b|\bwas received\b/.test(t);
  return { date: today, historical: past };
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Setting the book up
 * ------------------------------------------------------------------ */

export function readSetup(text: string, catalog: Catalog): SetupDraft | null {
  const t = ` ${text.toLowerCase()} `;
  if (!/\b(create|add|new|make|open|set up|setup|register)\b/.test(t)) return null;

  let kind: SetupKind | null = null;
  if (/\b(business|company|entity)\b/.test(t)) kind = 'business';
  else if (/\b(payroll|employee|worker|staff|salary|foreman|driver|guard|mason)\b/.test(t)) kind = 'payroll';
  else if (/\b(supplier|vendor|hardware|merchant)\b/.test(t)) kind = 'supplier';
  else if (/\b(project|job|site|contract)\b/.test(t)) kind = 'project';
  else if (/\b(account|cash box|cashbox|bank|wallet|agent|safe|till)\b/.test(t)) kind = 'account';
  else if (/\b(owes me|owes us|lent|borrower|debtor)\b/.test(t)) kind = 'lender';
  if (!kind) return null;

  const { amount } = readAmount(text);

  let businessId: Id | null = null;
  const hit = findAll(text, catalog).find((h) => h.kind === 'business');
  if (hit) businessId = hit.id;
  if (!businessId) {
    const m = text.match(/\b(?:under|for|in|inside|belongs to)\s+([A-Za-z][A-Za-z0-9 &'-]{1,30})/i);
    if (m) {
      const want = m[1].trim().toLowerCase();
      businessId = catalog.businesses.find((b) => want.startsWith(b.name.toLowerCase()))?.id ?? null;
    }
  }
  if (!businessId && kind !== 'business') businessId = catalog.businesses[0]?.id ?? null;

  const name = readName(text, catalog, businessId);
  return {
    mode: 'setup', kind, name, businessId, amount, raw: text,
    needs: name ? [] : ['name'],
  };
}

function readName(text: string, catalog: Catalog, businessId: Id | null): string {
  const quoted = text.match(/["“']([^"”']{2,40})["”']/);
  if (quoted) return tidy(quoted[1]);
  const called = text.match(/\b(?:called|named)\s+([A-Za-z0-9][A-Za-z0-9 &'.-]{1,40})/i);
  if (called) return tidy(called[1]);

  let rest = text
    .replace(/^\s*(please\s+)?(create|add|new|make|open|set up|setup|register)\b/i, ' ')
    .replace(/\b(a|an|the|another|new)\b/ig, ' ')
    .replace(/\b(business|company|entity|payroll|employee|worker|staff|salary|supplier|vendor|project|job|site|contract|account|cash box|cashbox|bank|wallet|agent|safe|till|for|under|in|inside|with|opening|balance|of|owes|me|us)\b/ig, ' ')
    .replace(/\$?\s*\d[\d.,]*\s*k?/g, ' ');
  const biz = catalog.businesses.find((b) => b.id === businessId);
  if (biz) rest = rest.replace(new RegExp(biz.name, 'ig'), ' ');
  return tidy(rest);
}

function tidy(s: string): string {
  return s.replace(/[^A-Za-z0-9 &'.-]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/* ------------------------------------------------------------------ *
 * Reading a transaction
 * ------------------------------------------------------------------ */

export function read(text: string, catalog: Catalog, today: string): Draft {
  const setup = readSetup(text, catalog);
  if (setup) return setup;

  const t = ` ${text.toLowerCase()} `;
  const { amount, quantity } = readAmount(text);
  const { date, historical } = readDate(text, today);

  const hits = findAll(text, catalog);
  const accounts = hits.filter((h) => h.kind === 'account');
  const project = hits.find((h) => h.kind === 'project');
  const person = hits.find((h) => h.kind === 'person');
  const businesses = hits.filter((h) => h.kind === 'business');

  const guessed: string[] = [];
  let accountId: Id | null = accounts[0]?.id ?? null;
  let toAccountId: Id | null = null;
  let personId: Id | null = person?.id ?? null;
  const projectId: Id | null = project?.id ?? null;

  const buying = /\b(bought|buy|buying|purchased|purchase|took|take|taking|order|ordered|delivered|supplied|invoiced)\b/.test(t);
  const unpaid = /\b(on credit|not paid|unpaid|didn'?t pay|did not pay|haven'?t paid|have not paid|owe|owing|pay later|later)\b/.test(t);
  const moving = /\b(to|into|withdraw|withdrawn|transfer|transferred|repayment|repay|repaid|move|moved|sent)\b/.test(t);
  const receiving = /\b(from|collected|received|receipt|payment|paid us|came in)\b/.test(t);

  let kind: EntryKind;
  if (!accounts.length && (buying || unpaid) && amount >= 0) {
    kind = 'credit_purchase';
    accountId = null;
  } else if (accounts.length > 1 && moving) {
    kind = 'transfer';
    accountId = accounts[0].id;
    toAccountId = accounts[1].id;
  } else if (project && receiving) {
    kind = 'receipt';
  } else if (person) {
    const p = catalog.people.find((x) => x.id === person.id)!;
    if (p.kind === 'receivable' && /\bloan|lent|lend|advance\b/.test(t)) kind = 'person_loan';
    else if (p.kind === 'salary') kind = 'salary';
    else if (p.kind === 'payable' && /\bpay|paid|settle|settled\b/.test(t)) kind = 'supplier_payment';
    else if (p.kind === 'payable') kind = 'credit_purchase';
    else kind = 'expense';
    if (kind === 'credit_purchase') accountId = null;
  } else {
    kind = 'expense';
  }

  // A business named without one of its accounts: assume its first account,
  // and say so — a large payment must never quietly leave the wrong box.
  if (!accountId && kind !== 'credit_purchase') {
    const named = businesses[0];
    const fallbackBusiness = named?.id ?? catalog.businesses[0]?.id;
    const account = catalog.accounts.find((a) => a.businessId === fallbackBusiness);
    if (account) { accountId = account.id; guessed.push('account'); }
  }

  // "for the bikes", "against the depot" — paid by one business for another
  let forBusiness: Id | null = null;
  if (kind !== 'transfer' && accountId) {
    const payer = catalog.accounts.find((a) => a.id === accountId)?.businessId;
    const other = businesses.find((b) => b.id !== payer);
    if (other) forBusiness = other.id;
  }

  const needs: string[] = [];
  if (!amount) needs.push('amount');
  if (kind === 'credit_purchase' && !personId) needs.push('person');
  if (kind !== 'credit_purchase' && !accountId) needs.push('account');
  if (kind === 'transfer' && !toAccountId) needs.push('account');
  if (kind === 'receipt' && !projectId) needs.push('project');

  return {
    mode: 'entry',
    quantity,
    needs,
    guessed,
    input: {
      occurredOn: date,
      kind,
      amount,
      purpose: purposeOf(text, catalog, kind, quantity, personId, projectId),
      raw: text,
      accountId, toAccountId, projectId, personId, forBusiness,
      historical, linkReceiptId: null,
    },
  };
}

function purposeOf(
  text: string, catalog: Catalog, kind: EntryKind,
  quantity: string | undefined, personId: Id | null, projectId: Id | null,
): string {
  let rest = text;
  for (const w of vocabulary(catalog)) {
    rest = rest.replace(new RegExp(`\\b${escape(w.phrase)}\\b`, 'ig'), ' ');
  }
  rest = rest
    .replace(/\$?\s*\d[\d.,]*\s*k?\b/g, ' ')
    .replace(/\b(i|we|from|to|into|for|against|the|and|put|it|of|on|with|this|that|my|a|an)\b/ig, ' ')
    .replace(/\b(bought|buy|buying|purchased|purchase|took|take|taking|order|ordered|delivered|supplied|invoiced|paid|pay|collected|received|withdrawn|withdraw|transfer|moved|move|loan|lent|salary)\b/ig, ' ')
    .replace(/\b(not|no|yet|later|credit|unpaid|owe|owing|didn'?t|haven'?t)\b/ig, ' ')
    .replace(/\b(tons?|tonnes?|kgs?|kg|bags?|sacs?|sacks?|pcs|pieces?|boxes|units?|litres?|liters?|m3|cbm|containers?|rolls?|sheets?|trucks?|loads?)\b/ig, ' ')
    .replace(/[.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (quantity) rest = `${quantity} ${rest}`.trim();
  if (rest) return tidyPurpose(rest);

  const person = catalog.people.find((p) => p.id === personId);
  const project = catalog.projects.find((p) => p.id === projectId);
  if (kind === 'receipt' && project) return `${project.name} receipt`;
  if (kind === 'transfer') return 'Cash moved';
  if (kind === 'credit_purchase') return 'Goods on credit';
  if (kind === 'supplier_payment' && person) return `Payment to ${person.name}`;
  if (kind === 'salary' && person) return `${person.name} salary`;
  if (kind === 'person_loan' && person) return `Loan to ${person.name}`;
  return 'Expense';
}

function tidyPurpose(s: string): string { return s[0].toUpperCase() + s.slice(1); }
function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
