import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { newId, query } from './db.js';
import { correctAmount, ensureLoanPair, loadBook, saveEntry } from './book.js';
import { readSentence } from './read.js';
import {
  accountBalance, businessCash, loanBalance, personBalance,
  possibleDuplicateReceipt, projectReceived, statement, totalCash,
} from '../shared/engine.js';

const app = express();
app.use(express.json());

/**
 * Phase 1 keeps the door shut with a shared token rather than accounts —
 * proper login, and a second user who can enter but not approve, is Phase 4.
 * With no token set the API is open, which is fine on your own machine.
 */
const TOKEN = process.env.APP_TOKEN;
app.use('/api', (req, res, next) => {
  if (!TOKEN || req.path === '/health') return next();
  if (req.get('x-book-token') === TOKEN) return next();
  res.status(401).json({ error: 'Not your book.' });
});

const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', wrap(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

/* ---------------- the whole book, with balances worked out ---------------- */

app.get('/api/book', wrap(async (req, res) => {
  const on = typeof req.query.on === 'string' ? req.query.on : undefined;
  const book = await loadBook();
  res.json({
    ...book,
    balances: {
      totalCash: totalCash(book, on),
      accounts: Object.fromEntries(book.accounts.map((a) => [a.id, accountBalance(book, a.id, on)])),
      businesses: Object.fromEntries(book.businesses.map((b) => [b.id, businessCash(book, b.id, on)])),
      people: Object.fromEntries(book.people.map((p) => [p.id, personBalance(book, p.id, on)])),
      loans: Object.fromEntries(book.loans.map((l) => [l.id, loanBalance(book, l, on)])),
      projects: Object.fromEntries(book.projects.map((p) => [p.id, projectReceived(book, p.id, on)])),
    },
  });
}));

app.get('/api/statement', wrap(async (req, res) => {
  const book = await loadBook();
  const { type, id, from, to } = req.query as Record<string, string | undefined>;
  const target =
    type === 'loan' && from && to ? { type: 'loan' as const, fromBusiness: from, toBusiness: to, view: from }
    : id ? { type: type as 'account' | 'person' | 'project', id }
    : null;
  if (!target) return res.status(400).json({ error: 'Say which account, person, project or loan.' });
  res.json({ rows: statement(book, target) });
}));

/* ---------------- reading a sentence ---------------- */

/**
 * Turns what he typed into a draft. Nothing is saved here — the draft goes back
 * to the screen, he confirms or corrects it, and only then is it logged.
 */
app.post('/api/read', wrap(async (req, res) => {
  const { text, today } = z.object({
    text: z.string().min(1).max(500),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.body);

  const book = await loadBook();
  const { draft, source } = await readSentence(text, book, today ?? new Date().toISOString().slice(0, 10));

  // A receipt the same size as one already recorded: is this new money, or that
  // money finally arriving? The screen asks rather than deciding.
  let duplicate = null;
  if (draft.mode === 'entry' && draft.input.kind === 'receipt' && draft.input.projectId && draft.input.amount) {
    duplicate = possibleDuplicateReceipt(book, draft.input.projectId, draft.input.amount);
  }
  res.json({ draft, source, duplicate });
}));

/* ---------------- setting the book up ---------------- */

const nameOnly = z.object({ name: z.string().min(1).max(80) });
const under = nameOnly.extend({ businessId: z.string().min(1), opening: z.number().default(0) });

app.post('/api/businesses', wrap(async (req, res) => {
  const { name } = nameOnly.parse(req.body);
  const id = newId('biz');
  await query('INSERT INTO businesses (id, name) VALUES ($1,$2)', [id, name]);
  // every pair of businesses can end up owing each other; open the positions now
  const others = await query<{ id: string }>('SELECT id FROM businesses WHERE id <> $1', [id]);
  for (const other of others) await ensureLoanPair(id, other.id);
  res.status(201).json({ id, name });
}));

app.post('/api/accounts', wrap(async (req, res) => {
  const { name, businessId, opening } = under.parse(req.body);
  const id = newId('acc');
  await query('INSERT INTO accounts (id, name, business_id, opening) VALUES ($1,$2,$3,$4)',
    [id, name, businessId, opening]);
  res.status(201).json({ id, name, businessId, opening });
}));

app.post('/api/projects', wrap(async (req, res) => {
  const body = under.extend({ scope: z.string().default('') }).parse(req.body);
  const id = newId('prj');
  await query('INSERT INTO projects (id, name, scope, business_id) VALUES ($1,$2,$3,$4)',
    [id, body.name, body.scope, body.businessId]);
  // anything already received before the cut-off is one opening line, not history to re-enter
  if (body.opening > 0) {
    await query(`INSERT INTO project_receipts (id, project_id, occurred_on, amount, in_cash, entry_id)
                 VALUES ($1,$2,NULL,$3,true,NULL)`, [newId('rcp'), id, body.opening]);
  }
  res.status(201).json({ id, ...body });
}));

app.post('/api/people', wrap(async (req, res) => {
  const body = under.extend({
    kind: z.enum(['receivable', 'payable', 'salary']),
    role: z.string().default(''),
    salary: z.number().default(0),
  }).parse(req.body);
  const id = newId('per');
  await query(`INSERT INTO people (id, name, role, business_id, kind, opening, salary)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, body.name, body.role, body.businessId, body.kind, body.opening, body.salary]);
  res.status(201).json({ id, ...body });
}));

/** The opening position between two businesses, as of the cut-off. */
app.put('/api/loans', wrap(async (req, res) => {
  const body = z.object({
    fromBusiness: z.string(), toBusiness: z.string(), opening: z.number(),
  }).parse(req.body);
  await ensureLoanPair(body.fromBusiness, body.toBusiness);
  await query(
    `UPDATE loans SET opening = CASE WHEN from_business = $1 THEN $3::numeric ELSE -($3::numeric) END
     WHERE (from_business = $1 AND to_business = $2) OR (from_business = $2 AND to_business = $1)`,
    [body.fromBusiness, body.toBusiness, body.opening]);
  res.json({ ok: true });
}));

/** A promise to pay, kept beside the book so it is not forgotten — never a movement. */
app.post('/api/reminders', wrap(async (req, res) => {
  const body = z.object({
    what: z.string().min(1).max(120),
    amount: z.number().default(0),
    accountId: z.string().nullish(),
    note: z.string().default(''),
  }).parse(req.body);
  const id = newId('rem');
  await query('INSERT INTO reminders (id, what, amount, account_id, note) VALUES ($1,$2,$3,$4,$5)',
    [id, body.what, body.amount, body.accountId ?? null, body.note]);
  res.status(201).json({ id, ...body });
}));

app.delete('/api/reminders/:id', wrap(async (req, res) => {
  await query('UPDATE reminders SET settled = true WHERE id = $1', [String(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------------- entries ---------------- */

const entryInput = z.object({
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['expense', 'credit_purchase', 'receipt', 'transfer', 'person_loan', 'salary', 'supplier_payment']),
  amount: z.number().positive(),
  purpose: z.string().default(''),
  raw: z.string().default(''),
  accountId: z.string().nullish(),
  toAccountId: z.string().nullish(),
  projectId: z.string().nullish(),
  personId: z.string().nullish(),
  forBusiness: z.string().nullish(),
  historical: z.boolean().default(false),
  linkReceiptId: z.string().nullish(),
});

app.post('/api/entries', wrap(async (req, res) => {
  const input = entryInput.parse(req.body);
  const book = await loadBook();

  // Guardrails the API enforces, so a wrong entry can never reach the book.
  if (input.kind === 'credit_purchase' && !input.personId) {
    return res.status(400).json({ error: 'A purchase on credit needs someone to owe.' });
  }
  if (input.kind === 'transfer' && (!input.accountId || !input.toAccountId)) {
    return res.status(400).json({ error: 'A transfer needs both accounts.' });
  }
  if (input.kind !== 'credit_purchase' && input.kind !== 'receipt' && !input.accountId && !input.historical) {
    return res.status(400).json({ error: 'Say which account the money came out of.' });
  }
  if (input.forBusiness && input.accountId) {
    const payer = book.accounts.find((a) => a.id === input.accountId)?.businessId;
    if (payer && payer !== input.forBusiness) await ensureLoanPair(payer, input.forBusiness);
  }
  if (input.kind === 'transfer') {
    const from = book.accounts.find((a) => a.id === input.accountId)?.businessId;
    const to = book.accounts.find((a) => a.id === input.toAccountId)?.businessId;
    if (from && to && from !== to) await ensureLoanPair(from, to);
  }

  const entry = await saveEntry(input, await loadBook());
  res.status(201).json(entry);
}));

/**
 * Asked before a receipt is saved: is this new money, or money already counted
 * that is only now arriving?
 */
app.get('/api/receipt-check', wrap(async (req, res) => {
  const { projectId, amount } = req.query as Record<string, string>;
  const book = await loadBook();
  res.json({ match: possibleDuplicateReceipt(book, projectId, Number(amount)) });
}));

app.patch('/api/entries/:id', wrap(async (req, res) => {
  const { amount } = z.object({ amount: z.number().positive() }).parse(req.body);
  await correctAmount(String(req.params.id), amount, await loadBook());
  res.json({ ok: true });
}));

/* ---------------- serving the app ---------------- */

const here = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(here, '..', 'dist')));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(here, '..', 'dist', 'index.html')));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.issues) return res.status(400).json({ error: 'That does not look right', details: err.issues });
  console.error(err);
  res.status(err?.status ?? 500).json({ error: err?.message ?? 'Something went wrong' });
});

const port = Number(process.env.PORT ?? 5000);
app.listen(port, () => console.log(`Book API on http://localhost:${port}`));
