import 'dotenv/config';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { newId, pool, query } from './db.js';
import { correctAmount, ensureLoanPair, loadBook, saveEntry, voidEntry } from './book.js';
import { history, record } from './audit.js';
import { backup, entriesCsv } from './export.js';
import { readSentence } from './read.js';
import { translateTexts } from './translate.js';
import { ownerOnly } from './auth.js';
import {
  loadSecuritySession,
  protectedSecurityRouter,
  publicSecurityRouter,
  requireAuthenticatedApi,
} from './security-gate.js';
import { dayReport } from './report.js';
import { delegationGate } from './delegation.js';
import {
  accountBalance,
  businessCash,
  loanBalance,
  personBalance,
  possibleDuplicateReceipt,
  projectReceived,
  statement,
  totalCash,
} from '../shared/engine.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(self), microphone=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  );
  next();
});

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set — the book would be open to anyone. Set it in .env.');
}

// Bound every API caller before any database, file, authorization or translation work.
// Login also has a durable database-backed throttle in security.ts.
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));

// Security routing is intentionally ordered. Express resolves the fixed public
// routes first; every other API call must then have a verified server-side
// session before it can reach any write or business workflow.
app.use('/api', loadSecuritySession);
app.use('/api', publicSecurityRouter);
app.use('/api', requireAuthenticatedApi);

app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('x-book') === '1') return next();
  res.status(403).json({ error: 'Refused: that request did not come from the app.' });
});

app.use('/api', protectedSecurityRouter);
app.use('/api', delegationGate);

const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
    type === 'loan' && from && to
      ? { type: 'loan' as const, fromBusiness: from, toBusiness: to, view: from }
      : id
        ? { type: type as 'account' | 'person' | 'project', id }
        : null;
  if (!target) return res.status(400).json({ error: 'Say which account, person, project or loan.' });
  res.json({ rows: statement(book, target) });
}));

/* ---------------- reading and translating sentences ---------------- */

app.post('/api/read', wrap(async (req, res) => {
  const { text, today } = z.object({
    text: z.string().min(1).max(500),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.body);
  const book = await loadBook();
  const { draft, source } = await readSentence(text, book, today ?? new Date().toISOString().slice(0, 10));
  let duplicate = null;
  if (draft.mode === 'entry' && draft.input.kind === 'receipt' && draft.input.projectId && draft.input.amount) {
    duplicate = possibleDuplicateReceipt(book, draft.input.projectId, draft.input.amount);
  }
  res.json({ draft, source, duplicate });
}));

app.post('/api/translate', wrap(async (req, res) => {
  const { language, texts } = z.object({
    language: z.enum(['en', 'fr', 'ar']),
    texts: z.array(z.string().min(1).max(800)).max(80),
  }).parse(req.body);
  if (texts.reduce((total, text) => total + text.length, 0) > 20_000) {
    return res.status(413).json({ error: 'Too much text to translate at once.' });
  }
  res.json(await translateTexts(language, texts));
}));

/* ---------------- setting the book up ---------------- */

const nameOnly = z.object({ name: z.string().min(1).max(80) });
const accountInput = nameOnly.extend({ businessId: z.string().nullish(), opening: z.number().default(0) });
const under = nameOnly.extend({ businessId: z.string().min(1), opening: z.number().default(0) });

app.post('/api/businesses', ownerOnly, wrap(async (req, res) => {
  const { name } = nameOnly.parse(req.body);
  const id = newId('biz');
  await query('INSERT INTO businesses (id, name) VALUES ($1,$2)', [id, name]);
  const others = await query<{ id: string }>('SELECT id FROM businesses WHERE id <> $1', [id]);
  for (const other of others) await ensureLoanPair(id, other.id);
  await record(req, 'business created', id, { name });
  res.status(201).json({ id, name });
}));

app.post('/api/accounts', ownerOnly, wrap(async (req, res) => {
  const { name, businessId, opening } = accountInput.parse(req.body);
  const id = newId('acc');
  await query(
    'INSERT INTO accounts (id, name, business_id, opening) VALUES ($1,$2,$3,$4)',
    [id, name, businessId ?? null, opening],
  );
  await record(req, 'account created', id, { name, opening, businessId: businessId ?? null });
  res.status(201).json({ id, name, businessId: businessId ?? null, opening });
}));

app.post('/api/projects', ownerOnly, wrap(async (req, res) => {
  const body = under.extend({ scope: z.string().default('') }).parse(req.body);
  const id = newId('prj');
  await query(
    'INSERT INTO projects (id, name, scope, business_id) VALUES ($1,$2,$3,$4)',
    [id, body.name, body.scope, body.businessId],
  );
  if (body.opening > 0) {
    await query(
      `INSERT INTO project_receipts (id, project_id, occurred_on, amount, in_cash, entry_id)
       VALUES ($1,$2,NULL,$3,true,NULL)`,
      [newId('rcp'), id, body.opening],
    );
  }
  await record(req, 'project created', id, { name: body.name, opening: body.opening });
  res.status(201).json({ id, ...body });
}));

app.post('/api/people', ownerOnly, wrap(async (req, res) => {
  const body = under.extend({
    kind: z.enum(['receivable', 'payable', 'salary']),
    role: z.string().default(''),
    salary: z.number().default(0),
  }).parse(req.body);
  const id = newId('per');
  await query(
    `INSERT INTO people (id, name, role, business_id, kind, opening, salary)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, body.name, body.role, body.businessId, body.kind, body.opening, body.salary],
  );
  await record(req, 'person created', id, {
    name: body.name,
    kind: body.kind,
    opening: body.opening,
    salary: body.salary,
  });
  res.status(201).json({ id, ...body });
}));

app.put('/api/loans', ownerOnly, wrap(async (req, res) => {
  const body = z.object({ fromBusiness: z.string(), toBusiness: z.string(), opening: z.number() }).parse(req.body);
  await ensureLoanPair(body.fromBusiness, body.toBusiness);
  await query(
    `UPDATE loans SET opening = CASE WHEN from_business = $1 THEN $3::numeric ELSE -($3::numeric) END
     WHERE (from_business = $1 AND to_business = $2) OR (from_business = $2 AND to_business = $1)`,
    [body.fromBusiness, body.toBusiness, body.opening],
  );
  await record(req, 'opening position set', null, body);
  res.json({ ok: true });
}));

app.post('/api/reminders', ownerOnly, wrap(async (req, res) => {
  const body = z.object({
    what: z.string().min(1).max(120),
    amount: z.number().default(0),
    accountId: z.string().nullish(),
    note: z.string().default(''),
  }).parse(req.body);
  const id = newId('rem');
  await query(
    'INSERT INTO reminders (id, what, amount, account_id, note) VALUES ($1,$2,$3,$4,$5)',
    [id, body.what, body.amount, body.accountId ?? null, body.note],
  );
  res.status(201).json({ id, ...body });
}));

app.delete('/api/reminders/:id', ownerOnly, wrap(async (req, res) => {
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
  clientRef: z.string().max(80).nullish(),
});

app.post('/api/entries', wrap(async (req, res) => {
  const input = entryInput.parse(req.body);
  const book = await loadBook();
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
  const entry = await saveEntry(input, await loadBook(), req.user?.id);
  await record(req, 'entry logged', entry.id, {
    amount: entry.amount,
    kind: entry.kind,
    purpose: entry.purpose,
    on: entry.occurredOn,
  });
  res.status(201).json(entry);
}));

app.get('/api/receipt-check', wrap(async (req, res) => {
  const { projectId, amount } = req.query as Record<string, string>;
  const book = await loadBook();
  res.json({ match: possibleDuplicateReceipt(book, projectId, Number(amount)) });
}));

app.patch('/api/entries/:id', ownerOnly, wrap(async (req, res) => {
  const { amount } = z.object({ amount: z.number().positive() }).parse(req.body);
  const id = String(req.params.id);
  const book = await loadBook();
  const before = book.entries.find((e) => e.id === id);
  await correctAmount(id, amount, book);
  await record(req, 'entry corrected', id, { from: before?.amount, to: amount, purpose: before?.purpose });
  res.json({ ok: true });
}));

app.post('/api/entries/:id/void', ownerOnly, wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
  const id = String(req.params.id);
  const before = (await loadBook()).entries.find((e) => e.id === id);
  await voidEntry(id, reason);
  await record(req, 'entry voided', id, { reason, amount: before?.amount, purpose: before?.purpose });
  res.json({ ok: true });
}));

/* ---------------- getting it out, and keeping it ---------------- */

app.get('/api/history', ownerOnly, wrap(async (_req, res) => {
  res.json({ lines: await history(300) });
}));

app.get('/api/export/entries.csv', ownerOnly, wrap(async (req, res) => {
  const book = await loadBook();
  await record(req, 'entries exported', null, { entries: book.entries.length });
  res.type('text/csv').attachment(`book-entries-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(entriesCsv(book));
}));

app.get('/api/backup.json', ownerOnly, wrap(async (req, res) => {
  const book = await loadBook();
  await record(req, 'backup taken');
  res.type('application/json').attachment(`book-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.send(backup(book));
}));

app.get('/api/report', wrap(async (req, res) => {
  const on = typeof req.query.on === 'string' ? req.query.on : new Date().toISOString().slice(0, 10);
  const book = await loadBook();
  res.type('text/plain').send(dayReport(book, on));
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
const server = app.listen(port, () => console.log(`Book API on http://localhost:${port}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
