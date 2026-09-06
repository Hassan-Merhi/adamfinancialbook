import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Router, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { accountBalance, withLoanEffects } from '../shared/engine.js';
import type { Book, Effect, Entry, EntryInput } from '../shared/types.js';
import type { OfflineConflictKind, OfflineSyncContext } from '../shared/offline-conflict.js';
import { recordRequired } from './audit.js';
import { newId, pool, query } from './db.js';
import { loadBook } from './book.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Reconnect bursts are bounded below the app-wide 300/min API ceiling. 429 is a
// retryable Phase 3 state, so throttling delays work without deleting it.
const offlineWriteLimit = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const accountExpectation = z.object({
  id: z.string(),
  businessId: z.string().nullable(),
  balance: z.number(),
});
const offlineContextSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  sourceAccount: accountExpectation.nullable(),
  destinationAccount: accountExpectation.nullable(),
  project: z.object({ id: z.string(), businessId: z.string() }).nullable(),
  person: z.object({
    id: z.string(),
    businessId: z.string(),
    kind: z.enum(['receivable', 'payable', 'salary']),
  }).nullable(),
  receipt: z.object({
    id: z.string(),
    projectId: z.string(),
    amount: z.number(),
    inCash: z.boolean(),
  }).nullable(),
});

const entrySchema = z.object({
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
  clientRef: z.string().min(1).max(80),
  offlineContext: offlineContextSchema,
});

type OfflineEntryBody = z.infer<typeof entrySchema>;

type DbRow = Record<string, any>;
interface AssignmentRow {
  user_id: string;
  email: string;
  account_name: string;
}
interface HandoffRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: number | string;
  purpose: string;
  occurred_on: Date | string;
  requested_by: string;
  recipient_user_id: string;
  status: 'pending' | 'confirmed' | 'rejected';
}

function day(value: Date | string | null): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function deterministicHandoffId(userId: string, clientRef: string): string {
  const digest = createHash('sha256')
    .update(userId)
    .update('\0')
    .update(clientRef)
    .digest('hex')
    .slice(0, 32);
  return `xfr_sync_${digest}`;
}

function conflictCode(kind: OfflineConflictKind): string {
  return `OFFLINE_CONFLICT_${kind.toUpperCase()}`;
}

function conflict(
  res: Response,
  kind: OfflineConflictKind,
  message: string,
  targetId: string | null,
  expected: unknown,
  current: unknown,
) {
  return res.status(409).json({
    error: message,
    code: conflictCode(kind),
    details: {
      kind,
      message,
      targetId,
      expected,
      current,
      detectedAt: new Date().toISOString(),
    },
  });
}

function asInput(body: OfflineEntryBody): EntryInput {
  return {
    occurredOn: body.occurredOn,
    kind: body.kind,
    amount: body.amount,
    purpose: body.purpose,
    raw: body.raw,
    accountId: body.accountId ?? null,
    toAccountId: body.toAccountId ?? null,
    projectId: body.projectId ?? null,
    personId: body.personId ?? null,
    forBusiness: body.forBusiness ?? null,
    historical: body.historical,
    linkReceiptId: body.linkReceiptId ?? null,
    clientRef: body.clientRef,
  };
}

function sameEntryRequest(row: DbRow, input: EntryInput): boolean {
  return day(row.occurred_on) === input.occurredOn
    && row.kind === input.kind
    && Math.abs(Number(row.amount) - input.amount) < 0.005
    && String(row.purpose ?? '') === input.purpose
    && String(row.raw ?? '') === input.raw
    && (row.account_id ?? null) === (input.accountId ?? null)
    && (row.to_account_id ?? null) === (input.toAccountId ?? null)
    && (row.project_id ?? null) === (input.projectId ?? null)
    && (row.person_id ?? null) === (input.personId ?? null)
    && (row.for_business ?? null) === (input.forBusiness ?? null)
    && Boolean(row.historical) === Boolean(input.historical)
    && (row.link_receipt_id ?? null) === (input.linkReceiptId ?? null);
}

function sameHandoffRequest(
  row: HandoffRow,
  body: { fromAccountId: string; toAccountId: string; amount: number; purpose: string; occurredOn: string },
  userId: string,
  recipientUserId?: string,
): boolean {
  return row.requested_by === userId
    && row.from_account_id === body.fromAccountId
    && row.to_account_id === body.toAccountId
    && Math.abs(Number(row.amount) - body.amount) < 0.005
    && row.purpose === body.purpose
    && day(row.occurred_on) === body.occurredOn
    && (recipientUserId === undefined || row.recipient_user_id === recipientUserId);
}

function effectFromRow(row: DbRow): Effect {
  return {
    type: row.type,
    targetId: row.target_id ?? undefined,
    fromBusiness: row.from_business ?? undefined,
    toBusiness: row.to_business ?? undefined,
    delta: Number(row.delta),
  };
}

function entryFromRow(row: DbRow, effects: Effect[] = []): Entry {
  return {
    id: row.id,
    occurredOn: day(row.occurred_on),
    kind: row.kind,
    amount: Number(row.amount),
    purpose: row.purpose,
    raw: row.raw,
    accountId: row.account_id,
    toAccountId: row.to_account_id,
    projectId: row.project_id,
    personId: row.person_id,
    forBusiness: row.for_business,
    historical: row.historical,
    linkReceiptId: row.link_receipt_id,
    clientRef: row.client_ref,
    effects,
    transactionId: row.transaction_id,
    correctedFrom: row.corrected_from == null ? null : Number(row.corrected_from),
    correctedAt: row.corrected_at ? new Date(row.corrected_at).toISOString() : null,
    correctedBy: row.corrected_by ?? null,
    correctionReason: row.correction_reason ?? '',
    voided: row.voided ?? false,
    voidReason: row.void_reason ?? null,
    voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    voidedBy: row.voided_by ?? null,
    createdBy: row.created_by ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function rows(client: PoolClient, sql: string, params: unknown[] = []): Promise<DbRow[]> {
  return (await client.query(sql, params)).rows as DbRow[];
}

/** Load the exact committed book visible while the Phase 4 write locks are held. */
async function loadLockedBook(client: PoolClient): Promise<Book> {
  const [businesses, accounts, projects, receipts, people, loans, entries, effects, reminders] = await Promise.all([
    rows(client, 'SELECT id, name FROM businesses ORDER BY created_at'),
    rows(client, 'SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    rows(client, 'SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    rows(client, 'SELECT id, project_id, occurred_on, amount, in_cash, entry_id FROM project_receipts WHERE voided_at IS NULL'),
    rows(client, 'SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    rows(client, 'SELECT id, from_business, to_business, opening FROM loans'),
    rows(client, 'SELECT * FROM entries ORDER BY occurred_on, created_at'),
    rows(client, 'SELECT * FROM effects WHERE active = true ORDER BY id'),
    rows(client, 'SELECT id, what, amount, account_id, note, settled FROM reminders WHERE settled = false ORDER BY created_at'),
  ]);
  const byEntry = new Map<string, Effect[]>();
  for (const row of effects) {
    const list = byEntry.get(row.entry_id) ?? [];
    list.push(effectFromRow(row));
    byEntry.set(row.entry_id, list);
  }
  return {
    businesses,
    accounts: accounts.map((item) => ({ id: item.id, name: item.name, businessId: item.business_id, opening: Number(item.opening) })),
    projects: projects.map((item) => ({ id: item.id, name: item.name, scope: item.scope, businessId: item.business_id })),
    receipts: receipts.map((item) => ({
      id: item.id,
      projectId: item.project_id,
      occurredOn: day(item.occurred_on),
      amount: Number(item.amount),
      inCash: item.in_cash,
      entryId: item.entry_id,
    })),
    people: people.map((item) => ({
      id: item.id,
      name: item.name,
      role: item.role,
      businessId: item.business_id,
      kind: item.kind,
      opening: Number(item.opening),
      salary: Number(item.salary),
    })),
    loans: loans.map((item) => ({
      id: item.id,
      fromBusiness: item.from_business,
      toBusiness: item.to_business,
      opening: Number(item.opening),
    })),
    entries: entries.map((item) => entryFromRow(item, byEntry.get(item.id) ?? [])),
    reminders: reminders.map((item) => ({
      id: item.id,
      what: item.what,
      amount: Number(item.amount),
      accountId: item.account_id,
      note: item.note,
      settled: item.settled,
    })),
  };
}

async function lockFinancialWriteWindow(client: PoolClient): Promise<void> {
  // Ordinary online entries acquire ROW EXCLUSIVE locks when they INSERT. This
  // stronger lock waits for any such write already in flight and blocks a new
  // one until the offline validation + posting transaction commits. Reads stay
  // available, so reconnect safety does not freeze the UI.
  await client.query(`LOCK TABLE
    entries, effects, project_receipts, accounts, projects, people, businesses,
    loans, user_accounts, pending_transfers
    IN SHARE ROW EXCLUSIVE MODE`);
}

async function ensureLoanPairLocked(client: PoolClient, from: string, to: string): Promise<void> {
  if (from === to) return;
  const existing = await client.query(
    `SELECT id FROM loans WHERE (from_business = $1 AND to_business = $2)
                              OR (from_business = $2 AND to_business = $1)`,
    [from, to],
  );
  if (!existing.rowCount) {
    await client.query(
      'INSERT INTO loans (id, from_business, to_business, opening) VALUES ($1,$2,$3,0)',
      [newId('loan'), from, to],
    );
  }
}

function validateContext(
  res: Response,
  input: EntryInput,
  context: OfflineSyncContext,
  book: Book,
): ReturnType<typeof conflict> | null {
  const checkAccount = (
    id: string | null | undefined,
    expected: OfflineSyncContext['sourceAccount'],
    label: string,
  ) => {
    if (!id) return null;
    const current = book.accounts.find((item) => item.id === id);
    if (!current) {
      return conflict(res, 'target_missing', `${label} no longer exists. Review this offline entry before syncing it.`, id, expected, null);
    }
    if (!expected || expected.id !== id) {
      return conflict(res, 'target_changed', `${label} was not the account this offline entry was based on.`, id, expected, current);
    }
    if ((current.businessId ?? null) !== expected.businessId) {
      return conflict(res, 'target_changed', `${label} moved to a different business while this device was offline.`, id, expected, current);
    }
    return null;
  };

  const sourceProblem = checkAccount(input.accountId, context.sourceAccount, 'The source account');
  if (sourceProblem) return sourceProblem;
  const destinationProblem = checkAccount(input.toAccountId, context.destinationAccount, 'The destination account');
  if (destinationProblem) return destinationProblem;

  if (input.projectId) {
    const current = book.projects.find((item) => item.id === input.projectId);
    if (!current) return conflict(res, 'target_missing', 'The linked project no longer exists.', input.projectId, context.project, null);
    if (!context.project || context.project.id !== current.id || context.project.businessId !== current.businessId) {
      return conflict(res, 'target_changed', 'The linked project changed while this device was offline.', input.projectId, context.project, current);
    }
  }
  if (input.personId) {
    const current = book.people.find((item) => item.id === input.personId);
    if (!current) return conflict(res, 'target_missing', 'The linked person or supplier no longer exists.', input.personId, context.person, null);
    if (!context.person || context.person.id !== current.id
      || context.person.businessId !== current.businessId || context.person.kind !== current.kind) {
      return conflict(res, 'target_changed', 'The linked person or supplier changed while this device was offline.', input.personId, context.person, current);
    }
  }
  if (input.linkReceiptId) {
    const current = book.receipts.find((item) => item.id === input.linkReceiptId);
    if (!current) return conflict(res, 'target_missing', 'The linked receipt no longer exists.', input.linkReceiptId, context.receipt, null);
    if (!context.receipt || context.receipt.id !== current.id
      || context.receipt.projectId !== current.projectId
      || Math.abs(context.receipt.amount - current.amount) > 0.005
      || context.receipt.inCash !== current.inCash) {
      return conflict(res, 'receipt_changed', 'The linked receipt changed while this device was offline.', input.linkReceiptId, context.receipt, current);
    }
  }

  if (input.accountId && context.sourceAccount) {
    const currentBalance = accountBalance(book, input.accountId);
    const effects = withLoanEffects(input, book);
    const sourceDelta = effects
      .filter((item) => item.type === 'account' && item.targetId === input.accountId)
      .reduce((sum, item) => sum + item.delta, 0);
    if (sourceDelta < -0.0001 && currentBalance + sourceDelta < -0.0001) {
      return conflict(
        res,
        'insufficient_funds',
        `This offline entry needs $${Math.abs(sourceDelta).toFixed(2)}, but the source account now has $${currentBalance.toFixed(2)}.`,
        input.accountId,
        { balance: context.sourceAccount.balance, required: Math.abs(sourceDelta) },
        { balance: currentBalance },
      );
    }
    if (sourceDelta < -0.0001 && Math.abs(currentBalance - context.sourceAccount.balance) > 0.005) {
      return conflict(
        res,
        'stale_balance',
        `The source balance changed from $${context.sourceAccount.balance.toFixed(2)} to $${currentBalance.toFixed(2)} while this device was offline. Review before posting.`,
        input.accountId,
        { balance: context.sourceAccount.balance },
        { balance: currentBalance },
      );
    }
  }
  return null;
}

async function writeEffects(client: PoolClient, entryId: string, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    await client.query(
      `INSERT INTO effects (entry_id, type, target_id, from_business, to_business, delta, active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [entryId, effect.type, effect.targetId ?? null, effect.fromBusiness ?? null, effect.toBusiness ?? null, effect.delta],
    );
  }
}

async function postOfflineEntryLocked(
  client: PoolClient,
  input: EntryInput,
  book: Book,
  createdBy: string,
): Promise<Entry> {
  const id = newId('ent');
  const transactionId = newId('txn');
  const effects = withLoanEffects(input, book);

  const payer = input.accountId ? book.accounts.find((item) => item.id === input.accountId)?.businessId : null;
  if (input.forBusiness && payer && payer !== input.forBusiness) {
    await ensureLoanPairLocked(client, payer, input.forBusiness);
  }
  if (input.kind === 'transfer' && input.accountId && input.toAccountId) {
    const from = book.accounts.find((item) => item.id === input.accountId)?.businessId;
    const to = book.accounts.find((item) => item.id === input.toAccountId)?.businessId;
    if (from && to && from !== to) await ensureLoanPairLocked(client, from, to);
  }

  await client.query(
    `INSERT INTO entries (id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
                          project_id, person_id, for_business, historical, link_receipt_id, client_ref,
                          created_by, transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, input.occurredOn, input.kind, input.amount, input.purpose, input.raw,
      input.accountId ?? null, input.toAccountId ?? null, input.projectId ?? null,
      input.personId ?? null, input.forBusiness ?? null, input.historical ?? false,
      input.linkReceiptId ?? null, input.clientRef ?? null, createdBy, transactionId,
    ],
  );
  await writeEffects(client, id, effects);

  if (input.kind === 'receipt') {
    if (input.linkReceiptId) {
      await client.query('UPDATE project_receipts SET in_cash = true WHERE id = $1 AND voided_at IS NULL', [input.linkReceiptId]);
    } else if (input.projectId) {
      await client.query(
        `INSERT INTO project_receipts (id, project_id, occurred_on, amount, in_cash, entry_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId('rcp'), input.projectId, input.occurredOn, input.amount, !input.historical, id],
      );
    }
  }

  await recordRequired(
    client,
    'financial entry posted',
    id,
    {
      amount: input.amount,
      kind: input.kind,
      purpose: input.purpose,
      occurredOn: input.occurredOn,
      clientRef: input.clientRef ?? null,
      createdBy,
      source: 'offline-sync',
    },
    transactionId,
  );

  return {
    id,
    ...input,
    effects,
    correctedFrom: null,
    correctedAt: null,
    correctedBy: null,
    correctionReason: '',
    voided: false,
    voidReason: null,
    voidedAt: null,
    voidedBy: null,
    transactionId,
    createdBy,
    createdAt: new Date().toISOString(),
  };
}

async function createHandoffLocked(
  client: PoolClient,
  req: Parameters<RequestHandler>[0],
  res: Response,
  input: EntryInput,
) {
  const assignmentResult = await client.query<AssignmentRow>(
    `SELECT ua.user_id, u.email, a.name AS account_name
       FROM user_accounts ua
       JOIN users u ON u.id = ua.user_id
       JOIN accounts a ON a.id = ua.account_id
      WHERE ua.account_id = $1`,
    [input.toAccountId],
  );
  const assignment = assignmentResult.rows[0];
  if (!assignment) {
    return conflict(res, 'permission_changed', 'The destination is no longer assigned to a delegated user.', input.toAccountId ?? null, 'delegated destination', null);
  }

  const body = {
    fromAccountId: input.accountId!,
    toAccountId: input.toAccountId!,
    amount: input.amount,
    purpose: input.purpose || 'Cash handoff',
    occurredOn: input.occurredOn,
  };
  const id = deterministicHandoffId(req.user!.id, input.clientRef!);
  const existing = await client.query<HandoffRow>(
    `SELECT id, from_account_id, to_account_id, amount, purpose, occurred_on,
            requested_by, recipient_user_id, status
       FROM pending_transfers WHERE id = $1`,
    [id],
  );
  const found = existing.rows[0];
  if (found) {
    if (!sameHandoffRequest(found, body, req.user!.id, assignment.user_id)) {
      return conflict(res, 'idempotency_key_reused', 'This offline idempotency key already belongs to a different cash handoff.', id, body, found);
    }
    return res.status(200).json({ mode: 'pending_transfer', id: found.id, status: found.status });
  }

  await client.query(
    `INSERT INTO pending_transfers
      (id, from_account_id, to_account_id, amount, purpose, occurred_on, requested_by, recipient_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, body.fromAccountId, body.toAccountId, body.amount, body.purpose, body.occurredOn, req.user!.id, assignment.user_id],
  );
  await client.query(
    `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
     VALUES ($1,$2,'transfer_waiting',$3,$4,'transfer',$5)`,
    [
      newId('ntf'), assignment.user_id,
      `$${body.amount.toFixed(2)} sent to ${assignment.account_name}`,
      `${req.user!.email} says this money was transferred. Confirm only after you actually receive it.`,
      id,
    ],
  );
  await recordRequired(
    client,
    'delegated transfer awaiting confirmation',
    id,
    { ...body, recipient: assignment.email, clientRef: input.clientRef, source: 'offline-sync' },
  );
  return res.status(201).json({ mode: 'pending_transfer', id, status: 'pending' });
}

/**
 * Phase 4 offline entry interception. Online requests do not carry an
 * offlineContext and fall through unchanged. Offline requests are validated and
 * posted inside one locked PostgreSQL transaction, making server state final.
 */
router.post('/entries', offlineWriteLimit, wrap(async (req, res, next) => {
  const candidate = req.body as { offlineContext?: unknown };
  if (!candidate?.offlineContext) return next();
  const body = entrySchema.parse(req.body);
  const input = asInput(body);
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('BEGIN');
    await lockFinancialWriteWindow(client);

    const existing = await client.query<DbRow>('SELECT * FROM entries WHERE client_ref = $1', [input.clientRef]);
    if (existing.rows[0]) {
      if (!sameEntryRequest(existing.rows[0], input)) {
        await client.query('ROLLBACK');
        finished = true;
        return conflict(res, 'idempotency_key_reused', 'This offline idempotency key already belongs to a different financial entry.', input.clientRef!, input, existing.rows[0]);
      }
      const effectRows = await client.query<DbRow>('SELECT * FROM effects WHERE entry_id = $1 AND active = true ORDER BY id', [existing.rows[0].id]);
      await client.query('COMMIT');
      finished = true;
      return res.status(200).json(entryFromRow(existing.rows[0], effectRows.rows.map(effectFromRow)));
    }

    const book = await loadLockedBook(client);

    if (req.user?.role !== 'owner') {
      if (input.kind !== 'expense' || !input.accountId || input.toAccountId || input.projectId || input.personId
        || input.forBusiness || input.historical || input.linkReceiptId) {
        await client.query('ROLLBACK');
        finished = true;
        return conflict(res, 'permission_changed', 'Your current access only allows expenses from an assigned cash account.', input.accountId ?? null, 'delegated expense', input.kind);
      }
      const assigned = await client.query('SELECT 1 FROM user_accounts WHERE user_id = $1 AND account_id = $2', [req.user!.id, input.accountId]);
      if (!assigned.rowCount) {
        await client.query('ROLLBACK');
        finished = true;
        return conflict(res, 'permission_changed', 'This account is no longer assigned to you. The offline expense was not posted.', input.accountId, 'assigned account', null);
      }
    }

    const problem = validateContext(res, input, body.offlineContext, book);
    if (problem) {
      await client.query('ROLLBACK');
      finished = true;
      return problem;
    }

    if (input.kind === 'credit_purchase' && !input.personId) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'target_missing', 'A purchase on credit still needs a supplier or person.', null, 'person', null);
    }
    if (input.kind === 'transfer' && (!input.accountId || !input.toAccountId)) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'target_missing', 'A transfer still needs both accounts.', null, 'two accounts', null);
    }

    // Offline owner funding of a delegated wallet becomes the same confirmation
    // handoff as the online flow, but retains the Phase 4 precondition check.
    if (req.user?.role === 'owner' && input.kind === 'transfer' && input.accountId && input.toAccountId) {
      const assignedDestination = await client.query('SELECT 1 FROM user_accounts WHERE account_id = $1', [input.toAccountId]);
      if (assignedDestination.rowCount) {
        const response = await createHandoffLocked(client, req, res, input);
        if (res.statusCode < 400) await client.query('COMMIT');
        else await client.query('ROLLBACK');
        finished = true;
        return response;
      }
    }

    const entry = await postOfflineEntryLocked(client, input, book, req.user!.id);
    if (req.user?.role === 'entry') {
      const accountName = book.accounts.find((item) => item.id === input.accountId)?.name ?? 'assigned account';
      const after = accountBalance({ ...book, entries: [...book.entries, entry] }, input.accountId!);
      const owners = await client.query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND active = true`);
      for (const owner of owners.rows) {
        await client.query(
          `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
           VALUES ($1,$2,'delegated_expense',$3,$4,'entry',$5)`,
          [
            newId('ntf'), owner.id,
            `${req.user!.email} spent $${input.amount.toFixed(2)}`,
            `${input.purpose || 'Expense'} from ${accountName}. Balance: $${after.toFixed(2)}.`,
            entry.id,
          ],
        );
      }
      await recordRequired(client, 'delegated expense logged', entry.id, {
        accountId: input.accountId,
        amount: input.amount,
        balanceAfter: after,
        source: 'offline-sync',
      });
    }
    await client.query('COMMIT');
    finished = true;
    return res.status(201).json(entry);
  } catch (error) {
    if (!finished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

/* -------------------------------------------------------------------------- */
/* Phase 3 idempotent delegated handoff route, kept for older clients/fallback. */
/* -------------------------------------------------------------------------- */

const handoffSchema = z.object({
  fromAccountId: z.string(),
  toAccountId: z.string(),
  amount: z.number().positive(),
  purpose: z.string().default('Cash handoff'),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clientRef: z.string().min(1).max(80),
});

async function existingHandoff(id: string): Promise<HandoffRow | null> {
  const found = await query<HandoffRow>(
    `SELECT id, from_account_id, to_account_id, amount, purpose, occurred_on,
            requested_by, recipient_user_id, status
       FROM pending_transfers WHERE id = $1`, [id],
  );
  return found[0] ?? null;
}

router.post('/delegation/transfers', offlineWriteLimit, wrap(async (req, res, next) => {
  const candidate = req.body as { clientRef?: unknown };
  if (typeof candidate?.clientRef !== 'string' || !candidate.clientRef) return next();
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can send delegated funds.' });
  const body = handoffSchema.parse(req.body);
  if (body.fromAccountId === body.toAccountId) return res.status(400).json({ error: 'Choose two different accounts.' });

  const id = deterministicHandoffId(req.user.id, body.clientRef);
  const prior = await existingHandoff(id);
  if (prior) {
    if (!sameHandoffRequest(prior, body, req.user.id)) {
      return res.status(409).json({
        error: 'That offline idempotency key was already used for a different cash handoff.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return res.status(200).json({ id: prior.id, status: prior.status });
  }

  const assignmentRows = await query<AssignmentRow>(
    `SELECT ua.user_id, u.email, a.name AS account_name
       FROM user_accounts ua JOIN users u ON u.id = ua.user_id JOIN accounts a ON a.id = ua.account_id
      WHERE ua.account_id = $1`, [body.toAccountId],
  );
  const assignment = assignmentRows[0];
  if (!assignment) return res.status(400).json({ error: 'The destination must be assigned to a delegated user.' });
  const book = await loadBook();
  const available = accountBalance(book, body.fromAccountId);
  if (body.amount > available + 0.0001) {
    return res.status(409).json({ error: `Insufficient funds — the source account has $${available.toFixed(2)}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string; status: HandoffRow['status'] }>(
      `INSERT INTO pending_transfers
        (id, from_account_id, to_account_id, amount, purpose, occurred_on, requested_by, recipient_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING RETURNING id, status`,
      [id, body.fromAccountId, body.toAccountId, body.amount, body.purpose, body.occurredOn, req.user.id, assignment.user_id],
    );
    if (!inserted.rows[0]) {
      const duplicate = await client.query<HandoffRow>(
        `SELECT id, from_account_id, to_account_id, amount, purpose, occurred_on,
                requested_by, recipient_user_id, status FROM pending_transfers WHERE id = $1`, [id],
      );
      const row = duplicate.rows[0];
      if (!row || !sameHandoffRequest(row, body, req.user.id, assignment.user_id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'That offline idempotency key was already used for a different cash handoff.', code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      await client.query('COMMIT');
      return res.status(200).json({ id: row.id, status: row.status });
    }
    await client.query(
      `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
       VALUES ($1,$2,'transfer_waiting',$3,$4,'transfer',$5)`,
      [newId('ntf'), assignment.user_id, `$${body.amount.toFixed(2)} sent to ${assignment.account_name}`,
        `${req.user.email} says this money was transferred. Confirm only after you actually receive it.`, id],
    );
    await recordRequired(client, 'delegated transfer awaiting confirmation', id, {
      ...body, recipient: assignment.email,
    });
    await client.query('COMMIT');
    return res.status(201).json({ id, status: inserted.rows[0].status });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

export const offlineSyncRouter = router;
