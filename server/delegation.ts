import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { newId, pool, query } from './db.js';
import { loadBook, saveEntry } from './book.js';
import { listUsers } from './auth.js';
import { record } from './audit.js';
import { readSentence } from './read.js';
import { accountBalance, businessCash, statement, totalCash } from '../shared/engine.js';
import type { Book, EntryInput } from '../shared/types.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isoToday = () => new Date().toISOString().slice(0, 10);

interface AssignmentRow {
  account_id: string;
  user_id: string;
  email: string;
  account_name: string;
}

async function assignmentsForUser(userId: string): Promise<AssignmentRow[]> {
  return query<AssignmentRow>(
    `SELECT ua.account_id, ua.user_id, u.email, a.name AS account_name
       FROM user_accounts ua
       JOIN users u ON u.id = ua.user_id
       JOIN accounts a ON a.id = ua.account_id
      WHERE ua.user_id = $1
      ORDER BY a.created_at`, [userId]);
}

async function assignmentForAccount(accountId: string): Promise<AssignmentRow | null> {
  const rows = await query<AssignmentRow>(
    `SELECT ua.account_id, ua.user_id, u.email, a.name AS account_name
       FROM user_accounts ua
       JOIN users u ON u.id = ua.user_id
       JOIN accounts a ON a.id = ua.account_id
      WHERE ua.account_id = $1`, [accountId]);
  return rows[0] ?? null;
}

async function notify(userId: string, type: string, title: string, body: string, relatedType?: string, relatedId?: string) {
  await query(
    `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId('ntf'), userId, type, title, body, relatedType ?? null, relatedId ?? null]);
}

async function notifyOwners(type: string, title: string, body: string, relatedType?: string, relatedId?: string) {
  const owners = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
  await Promise.all(owners.map((o) => notify(o.id, type, title, body, relatedType, relatedId)));
}

function filteredBook(book: Book, accountIds: string[]): Book {
  const allowed = new Set(accountIds);
  const accounts = book.accounts.filter((a) => allowed.has(a.id));
  const businesses = book.businesses.filter((b) => accounts.some((a) => a.businessId === b.id));
  const entries = book.entries
    .filter((e) => !!e.accountId && allowed.has(e.accountId) || !!e.toAccountId && allowed.has(e.toAccountId))
    .map((e) => ({
      ...e,
      projectId: null,
      personId: null,
      forBusiness: null,
      effects: e.effects.filter((eff) => eff.type === 'account' && !!eff.targetId && allowed.has(eff.targetId)),
    }));
  return {
    businesses,
    accounts,
    projects: [],
    receipts: [],
    people: [],
    loans: [],
    entries,
    reminders: [],
  };
}

function balancesFor(book: Book) {
  return {
    totalCash: totalCash(book),
    accounts: Object.fromEntries(book.accounts.map((a) => [a.id, accountBalance(book, a.id)])),
    businesses: Object.fromEntries(book.businesses.map((b) => [b.id, businessCash(book, b.id)])),
    people: {},
    loans: {},
    projects: {},
  };
}

async function canSeeEntry(req: Request, entryId: string): Promise<boolean> {
  if (req.user?.role === 'owner') return true;
  const rows = await query<{ ok: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM entries e
       JOIN user_accounts ua ON ua.user_id = $2
        AND (ua.account_id = e.account_id OR ua.account_id = e.to_account_id)
      WHERE e.id = $1
    ) AS ok`, [entryId, req.user!.id]);
  return !!rows[0]?.ok;
}

async function canSeeApproval(req: Request, requestId: string): Promise<boolean> {
  if (req.user?.role === 'owner') return true;
  const rows = await query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM approval_requests WHERE id = $1 AND created_by = $2) AS ok`,
    [requestId, req.user!.id]);
  return !!rows[0]?.ok;
}

/* -------------------------------------------------------------------------- */
/* Intercept the existing book endpoints for delegated users.                 */
/* -------------------------------------------------------------------------- */

router.get('/book', wrap(async (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  const assignments = await assignmentsForUser(req.user!.id);
  const book = filteredBook(await loadBook(), assignments.map((a) => a.account_id));
  res.json({ ...book, balances: balancesFor(book) });
}));

router.get('/statement', wrap(async (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  const rawType = req.query.type;
  const rawId = req.query.id;
  if ((rawType !== undefined && typeof rawType !== 'string') || (rawId !== undefined && typeof rawId !== 'string')) {
    return res.status(400).json({ error: 'Statement query parameters must be supplied once as text.' });
  }
  const type = rawType;
  const id = rawId;
  if (type !== 'account' || !id) return res.status(403).json({ error: 'You can only open statements for your assigned accounts.' });
  const assignments = await assignmentsForUser(req.user!.id);
  if (!assignments.some((a) => a.account_id === id)) return res.status(403).json({ error: 'That account is not assigned to you.' });
  const book = filteredBook(await loadBook(), assignments.map((a) => a.account_id));
  res.json({ rows: statement(book, { type: 'account', id }) });
}));

router.get('/report', wrap(async (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  const on = typeof req.query.on === 'string' ? req.query.on : isoToday();
  const assignments = await assignmentsForUser(req.user!.id);
  const full = await loadBook();
  const book = filteredBook(full, assignments.map((a) => a.account_id));
  const lines = [`Daily wallet report — ${on}`];
  for (const account of book.accounts) {
    const relevant = book.entries.filter((e) => !e.voided && e.occurredOn === on && (e.accountId === account.id || e.toAccountId === account.id));
    const spent = relevant.filter((e) => e.kind !== 'transfer' && e.accountId === account.id).reduce((n, e) => n + e.amount, 0);
    const received = relevant.filter((e) => e.kind === 'transfer' && e.toAccountId === account.id).reduce((n, e) => n + e.amount, 0);
    lines.push(`${account.name}: balance $${accountBalance(book, account.id).toFixed(2)} · in $${received.toFixed(2)} · out $${spent.toFixed(2)}`);
  }
  res.type('text/plain').send(lines.join('\n'));
}));

router.post('/read', wrap(async (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  const { text, today } = z.object({
    text: z.string().min(1).max(500),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.body);
  const assignments = await assignmentsForUser(req.user!.id);
  if (!assignments.length) return res.status(403).json({ error: 'No cash account has been assigned to you yet.' });
  const book = filteredBook(await loadBook(), assignments.map((a) => a.account_id));
  const reading = await readSentence(text, book, today ?? isoToday());
  if (reading.draft.mode !== 'entry') {
    return res.status(403).json({ error: 'Your access is for spending from assigned cash accounts only.' });
  }
  const draft = reading.draft;
  draft.input.kind = 'expense';
  draft.input.toAccountId = null;
  draft.input.personId = null;
  draft.input.projectId = null;
  draft.input.forBusiness = null;
  draft.input.historical = false;
  const chosenAccountId = draft.input.accountId;
  if (!chosenAccountId || !assignments.some((a) => a.account_id === chosenAccountId)) {
    draft.input.accountId = assignments[0].account_id;
  }
  res.json({ ...reading, draft, duplicate: null });
}));

router.post('/entries', wrap(async (req, res, next) => {
  if (req.user?.role === 'owner') {
    const body = req.body as Partial<EntryInput>;
    if (body.kind === 'transfer' && body.toAccountId && await assignmentForAccount(body.toAccountId)) {
      return res.status(409).json({ error: 'That account belongs to a delegated user. Use Wallet & approvals → Send money so they can confirm receipt.' });
    }
    return next();
  }

  const input = z.object({
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.literal('expense'),
    amount: z.number().positive(),
    purpose: z.string().default(''),
    raw: z.string().default(''),
    accountId: z.string().min(1),
    clientRef: z.string().max(80).nullish(),
  }).parse(req.body);

  const assignments = await assignmentsForUser(req.user!.id);
  if (!assignments.some((a) => a.account_id === input.accountId)) {
    return res.status(403).json({ error: 'That account is not assigned to you.' });
  }

  const book = await loadBook();
  const before = accountBalance(book, input.accountId);
  if (before <= 0) return res.status(409).json({ error: 'Insufficient funds — this account has no money left.' });
  if (input.amount > before + 0.0001) {
    return res.status(409).json({ error: `Insufficient funds — $${before.toFixed(2)} is available, not $${input.amount.toFixed(2)}.` });
  }

  const entry = await saveEntry({
    occurredOn: input.occurredOn,
    kind: 'expense',
    amount: input.amount,
    purpose: input.purpose,
    raw: input.raw,
    accountId: input.accountId,
    toAccountId: null,
    projectId: null,
    personId: null,
    forBusiness: null,
    historical: false,
    linkReceiptId: null,
    clientRef: input.clientRef ?? null,
  }, book, req.user!.id);

  const assignment = assignments.find((a) => a.account_id === input.accountId)!;
  const after = before - input.amount;
  await notifyOwners(
    'delegated_expense',
    `${req.user!.email} spent $${input.amount.toFixed(2)}`,
    `${input.purpose || 'Expense'} from ${assignment.account_name}. Balance: $${after.toFixed(2)}.`,
    'entry', entry.id,
  );
  await record(req, 'delegated expense logged', entry.id, { accountId: input.accountId, amount: input.amount, balanceAfter: after });
  res.status(201).json(entry);
}));

/* -------------------------------------------------------------------------- */
/* Dashboard and assignment management.                                       */
/* -------------------------------------------------------------------------- */

router.get('/delegation/dashboard', wrap(async (req, res) => {
  const book = await loadBook();
  const notifications = await query(
    `SELECT id, type, title, body, related_type, related_id, read_at, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.user!.id]);

  if (req.user?.role === 'owner') {
    const users = await listUsers();
    const assignments = await query<{ user_id: string; account_id: string }>('SELECT user_id, account_id FROM user_accounts');
    const pendingTransfers = await query(
      `SELECT pt.*, a1.name AS from_account_name, a2.name AS to_account_name, u.email AS recipient_email
         FROM pending_transfers pt
         JOIN accounts a1 ON a1.id = pt.from_account_id
         JOIN accounts a2 ON a2.id = pt.to_account_id
         JOIN users u ON u.id = pt.recipient_user_id
        WHERE pt.status = 'pending' ORDER BY pt.created_at DESC`);
    const approvals = await query(
      `SELECT ar.*, u.email AS requester_email, a.name AS account_name
         FROM approval_requests ar
         JOIN users u ON u.id = ar.created_by
         LEFT JOIN accounts a ON a.id = ar.account_id
        ORDER BY ar.created_at DESC LIMIT 100`);
    const recentActivity = await query(
      `SELECT e.id, e.occurred_on, e.amount, e.purpose, e.created_at, e.created_by,
              u.email AS actor_email, a.name AS account_name
         FROM entries e
         JOIN users u ON u.id = e.created_by
         LEFT JOIN accounts a ON a.id = e.account_id
        WHERE u.role = 'entry' AND e.voided = false
        ORDER BY e.created_at DESC LIMIT 100`);
    res.json({
      mode: 'owner',
      accounts: book.accounts.map((a) => ({ ...a, balance: accountBalance(book, a.id) })),
      delegates: users.filter((u) => u.role === 'entry').map((u) => ({
        id: u.id,
        email: u.email,
        accountIds: assignments.filter((a) => a.user_id === u.id).map((a) => a.account_id),
      })),
      pendingTransfers,
      approvals,
      recentActivity,
      notifications,
    });
    return;
  }

  const assignments = await assignmentsForUser(req.user!.id);
  const accountIds = assignments.map((a) => a.account_id);
  const filtered = filteredBook(book, accountIds);
  const today = isoToday();
  const accounts = filtered.accounts.map((a) => {
    const entries = filtered.entries.filter((e) => !e.voided && e.occurredOn === today && (e.accountId === a.id || e.toAccountId === a.id));
    return {
      ...a,
      balance: accountBalance(filtered, a.id),
      todayIn: entries.filter((e) => e.kind === 'transfer' && e.toAccountId === a.id).reduce((n, e) => n + e.amount, 0),
      todayOut: entries.filter((e) => e.kind !== 'transfer' && e.accountId === a.id).reduce((n, e) => n + e.amount, 0),
    };
  });
  const pendingTransfers = await query(
    `SELECT pt.*, a1.name AS from_account_name, a2.name AS to_account_name
       FROM pending_transfers pt
       JOIN accounts a1 ON a1.id = pt.from_account_id
       JOIN accounts a2 ON a2.id = pt.to_account_id
      WHERE pt.recipient_user_id = $1 AND pt.status = 'pending'
      ORDER BY pt.created_at DESC`, [req.user!.id]);
  const approvals = await query(
    `SELECT ar.*, a.name AS account_name
       FROM approval_requests ar LEFT JOIN accounts a ON a.id = ar.account_id
      WHERE ar.created_by = $1 ORDER BY ar.created_at DESC LIMIT 50`, [req.user!.id]);
  const recentActivity = filtered.entries.filter((e) => !e.voided).slice(-100).reverse().map((e) => ({
    id: e.id,
    occurred_on: e.occurredOn,
    amount: e.amount,
    purpose: e.purpose,
    kind: e.kind,
    account_name: filtered.accounts.find((a) => a.id === e.accountId)?.name
      ?? filtered.accounts.find((a) => a.id === e.toAccountId)?.name ?? '',
    created_by: e.createdBy,
  }));
  res.json({ mode: 'entry', accounts, pendingTransfers, approvals, recentActivity, notifications });
}));

router.put('/delegation/users/:id/accounts', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can assign accounts.' });
  const userId = String(req.params.id);
  const { accountIds } = z.object({ accountIds: z.array(z.string()).max(20) }).parse(req.body);
  const targetRows = await query<{ id: string; email: string; role: string }>('SELECT id, email, role FROM users WHERE id = $1', [userId]);
  const target = targetRows[0];
  if (!target || target.role !== 'entry') return res.status(400).json({ error: 'Choose an entry-only user.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    for (const accountId of [...new Set(accountIds)]) {
      const exists = await client.query('SELECT id FROM accounts WHERE id = $1', [accountId]);
      if (!exists.rowCount) throw Object.assign(new Error('One of those accounts does not exist.'), { status: 400 });
      const taken = await client.query('SELECT user_id FROM user_accounts WHERE account_id = $1', [accountId]);
      if (taken.rowCount && taken.rows[0].user_id !== userId) {
        throw Object.assign(new Error('One of those accounts is already assigned to someone else.'), { status: 409 });
      }
      await client.query('INSERT INTO user_accounts (account_id, user_id) VALUES ($1,$2)', [accountId, userId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await record(req, 'delegated accounts assigned', userId, { email: target.email, accountIds });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------------- */
/* Confirmed cash handoffs.                                                    */
/* -------------------------------------------------------------------------- */

router.post('/delegation/transfers', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can send delegated funds.' });
  const body = z.object({
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amount: z.number().positive(),
    purpose: z.string().default('Cash handoff'),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(isoToday()),
  }).parse(req.body);
  if (body.fromAccountId === body.toAccountId) return res.status(400).json({ error: 'Choose two different accounts.' });
  const assignment = await assignmentForAccount(body.toAccountId);
  if (!assignment) return res.status(400).json({ error: 'The destination must be assigned to a delegated user.' });
  const book = await loadBook();
  const available = accountBalance(book, body.fromAccountId);
  if (body.amount > available + 0.0001) {
    return res.status(409).json({ error: `Insufficient funds — the source account has $${available.toFixed(2)}.` });
  }
  const id = newId('xfr');
  await query(
    `INSERT INTO pending_transfers
      (id, from_account_id, to_account_id, amount, purpose, occurred_on, requested_by, recipient_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, body.fromAccountId, body.toAccountId, body.amount, body.purpose, body.occurredOn, req.user!.id, assignment.user_id]);
  await notify(
    assignment.user_id,
    'transfer_waiting',
    `$${body.amount.toFixed(2)} sent to ${assignment.account_name}`,
    `${req.user!.email} says this money was transferred. Confirm only after you actually receive it.`,
    'transfer', id,
  );
  await record(req, 'delegated transfer awaiting confirmation', id, { ...body, recipient: assignment.email });
  res.status(201).json({ id, status: 'pending' });
}));

router.post('/delegation/transfers/:id/confirm', wrap(async (req, res) => {
  if (req.user?.role !== 'entry') return res.status(403).json({ error: 'This confirmation belongs to the recipient.' });
  const id = String(req.params.id);
  const rows = await query<any>(
    `SELECT pt.*, a2.name AS to_account_name
       FROM pending_transfers pt JOIN accounts a2 ON a2.id = pt.to_account_id
      WHERE pt.id = $1 AND pt.recipient_user_id = $2`, [id, req.user!.id]);
  const transfer = rows[0];
  if (!transfer) return res.status(404).json({ error: 'No such transfer.' });
  if (transfer.status !== 'pending') return res.status(409).json({ error: `This transfer is already ${transfer.status}.` });

  const entry = await saveEntry({
    occurredOn: String(transfer.occurred_on).slice(0, 10),
    kind: 'transfer',
    amount: Number(transfer.amount),
    purpose: transfer.purpose,
    raw: `Confirmed cash handoff: ${transfer.purpose}`,
    accountId: transfer.from_account_id,
    toAccountId: transfer.to_account_id,
    projectId: null,
    personId: null,
    forBusiness: null,
    historical: false,
    linkReceiptId: null,
    clientRef: `handoff_${id}`,
  }, await loadBook(), transfer.requested_by);

  await query(
    `UPDATE pending_transfers SET status = 'confirmed', confirmed_at = now(), entry_id = $2
      WHERE id = $1 AND status = 'pending'`, [id, entry.id]);
  await notifyOwners(
    'transfer_confirmed',
    `${req.user!.email} confirmed $${Number(transfer.amount).toFixed(2)}`,
    `Money is now posted into ${transfer.to_account_name}.`,
    'transfer', id,
  );
  await record(req, 'delegated transfer confirmed', id, { entryId: entry.id, amount: Number(transfer.amount) });
  res.json({ ok: true, entryId: entry.id });
}));

router.post('/delegation/transfers/:id/reject', wrap(async (req, res) => {
  if (req.user?.role !== 'entry') return res.status(403).json({ error: 'This confirmation belongs to the recipient.' });
  const id = String(req.params.id);
  const rows = await query<any>(
    `UPDATE pending_transfers SET status = 'rejected', confirmed_at = now()
      WHERE id = $1 AND recipient_user_id = $2 AND status = 'pending'
      RETURNING amount`, [id, req.user!.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No pending transfer found.' });
  await notifyOwners(
    'transfer_rejected',
    `${req.user!.email} did not confirm $${Number(rows[0].amount).toFixed(2)}`,
    'The recipient says the money was not received. Nothing was posted to the book.',
    'transfer', id,
  );
  await record(req, 'delegated transfer rejected', id, { amount: Number(rows[0].amount) });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------------- */
/* Approval requests.                                                         */
/* -------------------------------------------------------------------------- */

router.post('/delegation/approvals', wrap(async (req, res) => {
  if (req.user?.role !== 'entry') return res.status(403).json({ error: 'Owners review requests; delegated users create them.' });
  const body = z.object({
    text: z.string().min(1).max(1000),
    amount: z.number().nonnegative().nullish(),
    accountId: z.string().nullish(),
  }).parse(req.body);
  const assignments = await assignmentsForUser(req.user!.id);
  const accountId = body.accountId ?? assignments[0]?.account_id ?? null;
  if (!accountId || !assignments.some((a) => a.account_id === accountId)) {
    return res.status(403).json({ error: 'Choose one of your assigned accounts.' });
  }
  const id = newId('apr');
  await query(
    `INSERT INTO approval_requests (id, created_by, account_id, request_text, amount)
     VALUES ($1,$2,$3,$4,$5)`, [id, req.user!.id, accountId, body.text, body.amount ?? null]);
  const account = assignments.find((a) => a.account_id === accountId)!;
  await notifyOwners(
    'approval_requested',
    `${req.user!.email} needs approval`,
    `${body.text}${body.amount ? ` · $${body.amount.toFixed(2)}` : ''} · ${account.account_name}`,
    'approval', id,
  );
  await record(req, 'approval requested', id, { accountId, amount: body.amount ?? null, text: body.text });
  res.status(201).json({ id, status: 'pending' });
}));

router.post('/delegation/approvals/:id/decision', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can approve or reject this.' });
  const id = String(req.params.id);
  const body = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(500).default('') }).parse(req.body);
  const rows = await query<any>(
    `UPDATE approval_requests
        SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING created_by, request_text, amount`, [id, body.status, req.user!.id, body.note]);
  const found = rows[0];
  if (!found) return res.status(404).json({ error: 'No pending request found.' });
  await notify(
    found.created_by,
    `approval_${body.status}`,
    `Request ${body.status}`,
    `${found.request_text}${body.note ? ` · ${body.note}` : ''}`,
    'approval', id,
  );
  await record(req, `approval ${body.status}`, id, { note: body.note, amount: found.amount });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------------- */
/* Receipt and evidence storage.                                               */
/* -------------------------------------------------------------------------- */

const imageBody = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  limit: '6mb',
});

type AttachmentTarget =
  | { type: 'entry'; id: string }
  | { type: 'approval'; id: string };

async function canSeeAttachmentTarget(req: Request, target: AttachmentTarget): Promise<boolean> {
  return target.type === 'entry'
    ? canSeeEntry(req, target.id)
    : canSeeApproval(req, target.id);
}

async function saveAttachment(req: Request, res: express.Response, target: AttachmentTarget) {
  if (!(await canSeeAttachmentTarget(req, target))) {
    return res.status(403).json({ error: target.type === 'entry' ? 'You cannot attach to that expense.' : 'You cannot attach to that request.' });
  }
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) return res.status(400).json({ error: 'Choose a receipt or photo first.' });

  const requestedMime = req.get('content-type');
  const mime = requestedMime === 'image/jpeg' ? 'image/jpeg'
    : requestedMime === 'image/png' ? 'image/png'
    : requestedMime === 'image/webp' ? 'image/webp'
    : requestedMime === 'application/pdf' ? 'application/pdf'
    : null;
  if (!mime) return res.status(415).json({ error: 'Use a JPG, PNG, WebP or PDF.' });

  const id = newId('att');
  const extension = mime === 'image/jpeg' ? 'jpg'
    : mime === 'image/png' ? 'png'
    : mime === 'image/webp' ? 'webp'
    : 'pdf';
  const filename = `evidence-${id}.${extension}`;
  const entryId = target.type === 'entry' ? target.id : null;
  const requestId = target.type === 'approval' ? target.id : null;

  await query(
    `INSERT INTO attachments
      (id, uploaded_by, entry_id, approval_request_id, filename, mime_type, byte_size, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, req.user!.id, entryId, requestId, filename, mime, data.length, data]);
  if (req.user?.role === 'entry') {
    await notifyOwners(
      'evidence_added',
      `${req.user!.email} added evidence`,
      `${filename} was attached to ${target.type === 'entry' ? 'an expense' : 'an approval request'}.`,
      target.type === 'entry' ? 'entry' : 'approval', target.id,
    );
  }
  await record(req, 'evidence attached', id, {
    filename,
    bytes: data.length,
    entryId,
    requestId,
  });
  return res.status(201).json({ id, filename, mimeType: mime, byteSize: data.length });
}

async function listAttachments(req: Request, res: express.Response, target: AttachmentTarget) {
  if (!(await canSeeAttachmentTarget(req, target))) {
    return res.status(403).json({ error: target.type === 'entry' ? 'You cannot view that expense.' : 'You cannot view that request.' });
  }
  const rows = target.type === 'entry'
    ? await query(
      `SELECT id, filename, mime_type, byte_size, created_at
         FROM attachments WHERE entry_id = $1 ORDER BY created_at`, [target.id])
    : await query(
      `SELECT id, filename, mime_type, byte_size, created_at
         FROM attachments WHERE approval_request_id = $1 ORDER BY created_at`, [target.id]);
  return res.json({ files: rows });
}

router.post('/delegation/attachments/entry/:entryId', imageBody, wrap(async (req, res) => {
  const entryId = String(req.params.entryId);
  return saveAttachment(req, res, { type: 'entry', id: entryId });
}));

router.post('/delegation/attachments/request/:requestId', imageBody, wrap(async (req, res) => {
  const requestId = String(req.params.requestId);
  return saveAttachment(req, res, { type: 'approval', id: requestId });
}));

router.get('/delegation/attachments/entry/:entryId', wrap(async (req, res) => {
  const entryId = String(req.params.entryId);
  return listAttachments(req, res, { type: 'entry', id: entryId });
}));

router.get('/delegation/attachments/request/:requestId', wrap(async (req, res) => {
  const requestId = String(req.params.requestId);
  return listAttachments(req, res, { type: 'approval', id: requestId });
}));

router.get('/delegation/attachments/:id', wrap(async (req, res) => {
  const id = String(req.params.id);
  const rows = await query<any>(
    `SELECT id, entry_id, approval_request_id, filename, mime_type, byte_size, data
       FROM attachments WHERE id = $1`, [id]);
  const file = rows[0];
  if (!file) return res.status(404).json({ error: 'No such file.' });
  if (file.entry_id && !(await canSeeEntry(req, file.entry_id))) return res.status(403).json({ error: 'You cannot view this file.' });
  if (file.approval_request_id && !(await canSeeApproval(req, file.approval_request_id))) return res.status(403).json({ error: 'You cannot view this file.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Length', String(file.byte_size));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.send(file.data);
}));

/* -------------------------------------------------------------------------- */
/* Notifications.                                                             */
/* -------------------------------------------------------------------------- */

router.post('/delegation/notifications/:id/read', wrap(async (req, res) => {
  await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2',
    [String(req.params.id), req.user!.id]);
  res.json({ ok: true });
}));

router.post('/delegation/notifications/read-all', wrap(async (req, res) => {
  await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1', [req.user!.id]);
  res.json({ ok: true });
}));

export const delegationGate = router;