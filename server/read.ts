/**
 * Reading a sentence with Claude.
 *
 * The rules reader in `shared/parse.ts` handles the phrasings we know about.
 * This one handles the rest — "soficom is where i keep the kin severe money,
 * about 25k in it" — by giving Claude the book's own vocabulary and asking it
 * to fill in one strict shape.
 *
 * Two things it never does: save anything, or invent an id. Every id it returns
 * is checked against the catalog and dropped if it is not real, and the result
 * is still only a draft for the screen to confirm.
 */

import Anthropic from '@anthropic-ai/sdk';
import { read as readWithRules } from '../shared/parse.js';
import type { Draft, SetupKind } from '../shared/parse.js';
import type { Catalog, EntryKind, Id } from '../shared/types.js';

const MODEL = 'claude-opus-5';

const ENTRY_KINDS: EntryKind[] = [
  'expense', 'credit_purchase', 'receipt', 'transfer', 'person_loan', 'salary', 'supplier_payment',
];
const SETUP_KINDS: SetupKind[] = ['business', 'account', 'project', 'payroll', 'supplier', 'lender'];

const READING_TOOL: Anthropic.Tool = {
  name: 'record_reading',
  description: 'Report how the sentence was read. Every id must come from the catalog.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['entry', 'setup'] },
      kind: { type: 'string', enum: [...ENTRY_KINDS, ...SETUP_KINDS, 'none'] },
      amount: { type: 'number', description: 'A price in dollars. 0 when the sentence only gave a quantity.' },
      quantity: { type: 'string', description: 'e.g. "1 ton" when a number was a count, not a price. Empty otherwise.' },
      occurredOn: { type: 'string', description: 'YYYY-MM-DD' },
      historical: { type: 'boolean', description: 'Recording something that already happened: it must not move today\'s cash.' },
      purpose: { type: 'string', description: 'A few words: what it was for.' },
      accountId: { type: 'string', description: 'Catalog id, or "" if none was named.' },
      toAccountId: { type: 'string', description: 'Transfers only. Catalog id or "".' },
      projectId: { type: 'string', description: 'Catalog id or "".' },
      personId: { type: 'string', description: 'Catalog id or "".' },
      forBusiness: { type: 'string', description: 'Paid by one business for another: the business it was FOR. Catalog id or "".' },
      name: { type: 'string', description: 'Setup only: what to call the new thing.' },
      businessId: { type: 'string', description: 'Setup only: which business it belongs under. Catalog id or "".' },
    },
    required: ['mode', 'kind', 'amount', 'quantity', 'occurredOn', 'historical', 'purpose',
      'accountId', 'toAccountId', 'projectId', 'personId', 'forBusiness', 'name', 'businessId'],
    additionalProperties: false,
  },
};

function catalogSheet(catalog: Catalog): string {
  const lines: string[] = [];
  const list = (title: string, rows: string[]) => {
    lines.push(title);
    lines.push(rows.length ? rows.map((r) => `  ${r}`).join('\n') : '  (none yet)');
  };
  const business = (id: Id) => catalog.businesses.find((b) => b.id === id)?.name ?? '?';
  list('BUSINESSES', catalog.businesses.map((b) => `${b.id} — ${b.name}`));
  list('ACCOUNTS', catalog.accounts.map((a) => `${a.id} — ${a.name} (${business(a.businessId)})`));
  list('PROJECTS', catalog.projects.map((p) => `${p.id} — ${p.name} (${business(p.businessId)})`));
  list('PEOPLE', catalog.people.map((p) => {
    const what = p.kind === 'payable' ? 'supplier, you owe them'
      : p.kind === 'salary' ? `payroll, salary ${p.salary}` : 'owes you';
    return `${p.id} — ${p.name} (${what})`;
  }));
  return lines.join('\n');
}

const SYSTEM = `You read one sentence from a man tracking money across several businesses he owns, and report how it should be entered in his book. You never save anything; a person confirms every reading on screen before it is kept.

How the book works:
- An expense leaves one account. A transfer moves money between two of his own accounts and is NOT spending.
- A receipt is a client paying one of his projects.
- Buying on credit means goods taken with nothing paid: no account is touched, only what he owes that supplier grows. Use credit_purchase when a purchase names no account, or says on credit / not paid / pay later.
- Money spent by one business on behalf of another sets forBusiness. Never guess this: only set it when the sentence names the other business.
- A person can owe him money, be on payroll, and sell to him. Use the person's kind in the catalog to choose between person_loan, salary and supplier_payment.
- historical means he is recording something that already happened, so it must not move today's cash. A date written in the past, "back in March", "previously" all mean historical.

Reading rules:
- Every id must be copied exactly from the catalog. If the sentence names something that is not in the catalog, leave the id "" — do not invent one and do not substitute a similar name.
- Do not guess an account that was not named. Leave accountId "" and the screen will ask.
- A count is not a price: "1 ton of bricks" is quantity "1 ton" with amount 0, unless a price is also given.
- mode "setup" is for sentences that create something — a business, an account, a project, a payroll worker, a supplier, a person who owes him. Then kind is the setup kind, name is what to call it, businessId is where it goes, and amount is its opening figure (a salary for payroll).
- Anything else is mode "entry".`;

/** null means "could not read it" — the caller falls back to the rules reader. */
export async function readWithClaude(text: string, catalog: Catalog, today: string): Promise<Draft | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;

  const client = new Anthropic();
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: MODEL,
    max_tokens: 2_000,
    system: SYSTEM,
    output_config: { effort: 'low' },
    tools: [READING_TOOL],
    tool_choice: { type: 'tool', name: 'record_reading' },
    messages: [{
      role: 'user',
      content: `Today is ${today}.\n\nThe book contains:\n${catalogSheet(catalog)}\n\nThe sentence:\n${text}`,
    }],
  };

  try {
    let response: Anthropic.Message;
    try {
      // A policy decline would leave him with no reading at all; let the API
      // rescue the request on its own rather than failing the entry.
      response = await client.beta.messages.create({
        ...request,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as never) as unknown as Anthropic.Message;
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      response = await client.messages.create(request);   // older API: no fallbacks
    }

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return null;
    return normalise(call.input as Record<string, unknown>, text, catalog, today);
  } catch (err) {
    console.warn('Claude could not read the sentence, using the rules reader:', (err as Error).message);
    return null;
  }
}

/** Trusts nothing: every id is checked against the catalog before it is used. */
function normalise(raw: Record<string, unknown>, text: string, catalog: Catalog, today: string): Draft | null {
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  const id = (k: string, pool: { id: Id }[]): Id | null => {
    const v = str(k);
    return v && pool.some((x) => x.id === v) ? v : null;
  };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str('occurredOn')) ? str('occurredOn') : today;
  const amount = typeof raw.amount === 'number' && raw.amount > 0 ? Math.round(raw.amount * 100) / 100 : 0;
  const kind = str('kind');

  if (str('mode') === 'setup') {
    if (!SETUP_KINDS.includes(kind as SetupKind)) return null;
    const setupKind = kind as SetupKind;
    const name = str('name');
    return {
      mode: 'setup',
      kind: setupKind,
      name,
      businessId: id('businessId', catalog.businesses) ?? (setupKind === 'business' ? null : catalog.businesses[0]?.id ?? null),
      amount,
      raw: text,
      needs: name ? [] : ['name'],
    };
  }

  if (!ENTRY_KINDS.includes(kind as EntryKind)) return null;
  const entryKind = kind as EntryKind;
  const accountId = entryKind === 'credit_purchase' ? null : id('accountId', catalog.accounts);
  const toAccountId = entryKind === 'transfer' ? id('toAccountId', catalog.accounts) : null;
  const personId = id('personId', catalog.people);
  const projectId = id('projectId', catalog.projects);
  const forBusiness = id('forBusiness', catalog.businesses);
  const quantity = str('quantity') || undefined;

  const needs: string[] = [];
  if (!amount) needs.push('amount');
  if (entryKind === 'credit_purchase' && !personId) needs.push('person');
  if (entryKind !== 'credit_purchase' && !accountId) needs.push('account');
  if (entryKind === 'transfer' && !toAccountId) needs.push('account');
  if (entryKind === 'receipt' && !projectId) needs.push('project');

  return {
    mode: 'entry',
    quantity,
    needs,
    guessed: [],
    input: {
      occurredOn: date,
      kind: entryKind,
      amount,
      purpose: str('purpose') || 'Entry',
      raw: text,
      accountId, toAccountId, projectId, personId, forBusiness,
      historical: raw.historical === true,
      linkReceiptId: null,
    },
  };
}

/** Claude when a key is set and it succeeds; the rules reader otherwise. */
export async function readSentence(text: string, catalog: Catalog, today: string) {
  const fromClaude = await readWithClaude(text, catalog, today);
  if (fromClaude) return { draft: fromClaude, source: 'claude' as const };
  return { draft: readWithRules(text, catalog, today), source: 'rules' as const };
}
