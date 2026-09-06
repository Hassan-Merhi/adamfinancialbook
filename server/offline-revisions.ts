import { createHash } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { withLoanEffects } from '../shared/engine.js';
import {
  offlineEffectSignature,
  type OfflineConflictKind,
  type OfflineRevisionExpectation,
} from '../shared/offline-conflict.js';
import type { Effect, EntryInput } from '../shared/types.js';
import { recordRequired } from './audit.js';
import {
  captureEntryState,
  loadBook,
  supersedeEffects,
  writeEffects,
  writeEntryRevision,
} from './book.js';
import { pool } from './db.js';

const router = Router();
const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const offlineRevisionLimit = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const expectationSchema = z.object({
  id: z.string().min(1),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['expense', 'credit_purchase', 'receipt', 'transfer', 'person_loan', 'salary', 'supplier_payment']),
  amount: z.number().positive(),
  purpose: z.string(),
  raw: z.string(),
  accountId: z.string().nullable(),
  toAccountId: z.string().nullable(),
  projectId: z.string().nullable(),
  personId: z.string().nullable(),
  forBusiness: z.string().nullable(),
  historical: z.boolean(),
  linkReceiptId: z.string().nullable(),
  correctedFrom: z.number().nullable(),
  correctedAt: z.string().nullable(),
  voided: z.boolean(),
  voidedAt: z.string().nullable(),
  effectSignature: z.string(),
});

const revisionContextSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  entry: expectationSchema,
});

const correctionSchema = z.object({
  amount: z.number().positive(),
  clientRef: z.string().min(1).max(80),
  offlineContext: revisionContextSchema,
});

const voidSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  clientRef: z.string().min(1).max(80),
  offlineContext: revisionContextSchema,
});

type DbRow = Record<string, any>;
type RevisionKind = 'correction' | 'void';

interface ExistingRevision {
  entry_id: string;
  revision_type: RevisionKind | 'classification';
  reason: string;
  before_entry: DbRow;
  after_entry: DbRow;
  client_ref: string;
}

function day(value: Date | string | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function time(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function expectationFromState(state: { entry: DbRow; effects: DbRow[] }): OfflineRevisionExpectation {
  const row = state.entry;
  return {
    id: row.id,
    occurredOn: day(row.occurred_on),
    kind: row.kind,
    amount: Number(row.amount),
    purpose: String(row.purpose ?? ''),
    raw: String(row.raw ?? ''),
    accountId: row.account_id ?? null,
    toAccountId: row.to_account_id ?? null,
    projectId: row.project_id ?? null,
    personId: row.person_id ?? null,
    forBusiness: row.for_business ?? null,
    historical: Boolean(row.historical),
    linkReceiptId: row.link_receipt_id ?? null,
    correctedFrom: row.corrected_from == null ? null : Number(row.corrected_from),
    correctedAt: time(row.corrected_at),
    voided: Boolean(row.voided),
    voidedAt: time(row.voided_at),
    effectSignature: offlineEffectSignature(state.effects.map(effectFromRow)),
  };
}

function sameMoney(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.005;
}

function sameExpectation(expected: OfflineRevisionExpectation, current: OfflineRevisionExpectation): boolean {
  return expected.id === current.id
    && expected.occurredOn === current.occurredOn
    && expected.kind === current.kind
    && sameMoney(expected.amount, current.amount)
    && expected.purpose === current.purpose
    && expected.raw === current.raw
    && expected.accountId === current.accountId
    && expected.toAccountId === current.toAccountId
    && expected.projectId === current.projectId
    && expected.personId === current.personId
    && expected.forBusiness === current.forBusiness
    && expected.historical === current.historical
    && expected.linkReceiptId === current.linkReceiptId
    && sameMoney(expected.correctedFrom, current.correctedFrom)
    && expected.correctedAt === current.correctedAt
    && expected.voided === current.voided
    && expected.voidedAt === current.voidedAt
    && expected.effectSignature === current.effectSignature;
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

function transactionId(userId: string, clientRef: string): string {
  const digest = createHash('sha256')
    .update(userId)
    .update('\0')
    .update(clientRef)
    .digest('hex')
    .slice(0, 32);
  return `txn_offrev_${digest}`;
}

function inputFromRow(row: DbRow): EntryInput {
  return {
    occurredOn: day(row.occurred_on),
    kind: row.kind,
    amount: Number(row.amount),
    purpose: String(row.purpose ?? ''),
    raw: String(row.raw ?? ''),
    accountId: row.account_id ?? null,
    toAccountId: row.to_account_id ?? null,
    projectId: row.project_id ?? null,
    personId: row.person_id ?? null,
    forBusiness: row.for_business ?? null,
    historical: Boolean(row.historical),
    linkReceiptId: row.link_receipt_id ?? null,
    clientRef: row.client_ref ?? null,
  };
}

async function existingRevision(client: { query: Function }, clientRef: string): Promise<ExistingRevision | null> {
  const result = await client.query(
    `SELECT entry_id, revision_type, reason, before_entry, after_entry, client_ref
       FROM entry_revisions WHERE client_ref = $1`,
    [clientRef],
  );
  return result.rows[0] ?? null;
}

function replayMatches(
  found: ExistingRevision,
  kind: RevisionKind,
  entryId: string,
  amount?: number,
  reason?: string,
): boolean {
  if (found.entry_id !== entryId || found.revision_type !== kind) return false;
  if (kind === 'correction') return Math.abs(Number(found.after_entry?.amount) - Number(amount)) < 0.005;
  return found.reason === reason;
}

async function replayOrConflict(
  client: { query: Function },
  res: Response,
  clientRef: string,
  kind: RevisionKind,
  entryId: string,
  amount?: number,
  reason?: string,
): Promise<boolean> {
  const found = await existingRevision(client, clientRef);
  if (!found) return false;
  if (!replayMatches(found, kind, entryId, amount, reason)) {
    conflict(
      res,
      'idempotency_key_reused',
      'This offline revision key already belongs to a different correction or void.',
      entryId,
      { kind, entryId, amount: amount ?? null, reason: reason ?? null },
      found,
    );
    return true;
  }
  res.status(200).json({ ok: true, mode: kind, entryId, clientRef, replay: true });
  return true;
}

async function persistRevisionClientRef(
  client: { query: Function },
  txId: string,
  clientRef: string,
): Promise<void> {
  await client.query(
    'UPDATE entry_revisions SET client_ref = $2 WHERE transaction_id = $1',
    [txId, clientRef],
  );
}

function ownerRequired(req: Parameters<RequestHandler>[0], res: Response, entryId: string): boolean {
  if (req.user?.role === 'owner') return true;
  conflict(
    res,
    'permission_changed',
    'Only an owner can correct or void ledger history. Your current access no longer allows this queued change.',
    entryId,
    'owner',
    req.user?.role ?? null,
  );
  return false;
}

router.patch('/entries/:id', offlineRevisionLimit, wrap(async (req, res, next) => {
  const candidate = req.body as { offlineContext?: unknown; clientRef?: unknown };
  if (!candidate?.offlineContext || typeof candidate.clientRef !== 'string') return next();
  const body = correctionSchema.parse(req.body);
  const entryId = String(req.params.id);
  if (!ownerRequired(req, res, entryId)) return;
  if (body.offlineContext.entry.id !== entryId) {
    return conflict(res, 'target_changed', 'The queued correction points at a different entry than its captured context.', entryId, body.offlineContext.entry.id, entryId);
  }

  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offline-revision:${body.clientRef}`]);
    if (await replayOrConflict(client, res, body.clientRef, 'correction', entryId, body.amount)) {
      await client.query(res.statusCode < 400 ? 'COMMIT' : 'ROLLBACK');
      finished = true;
      return;
    }

    const before = await captureEntryState(client, entryId, true);
    if (!before) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'target_missing', 'The entry no longer exists. The offline correction was not applied.', entryId, body.offlineContext.entry, null);
    }
    const current = expectationFromState(before);
    if (!sameExpectation(body.offlineContext.entry, current)) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'entry_changed', 'This entry changed while the device was offline. Review the latest entry before correcting it.', entryId, body.offlineContext.entry, current);
    }
    if (before.entry.voided || before.entry.corrected_at || before.entry.corrected_from != null) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'entry_changed', 'This entry is no longer eligible for that correction. Review its latest state.', entryId, body.offlineContext.entry, current);
    }

    const oldAmount = Number(before.entry.amount);
    const reason = `Amount corrected from ${oldAmount.toFixed(2)} to ${body.amount.toFixed(2)}`;
    const book = await loadBook();
    const nextInput = { ...inputFromRow(before.entry), amount: body.amount };
    const effects = withLoanEffects(nextInput, book);
    const txId = transactionId(req.user!.id, body.clientRef);

    await client.query(
      `UPDATE entries
          SET amount = $2,
              corrected_from = COALESCE(corrected_from, $3),
              corrected_at = now(),
              corrected_by = $4,
              correction_reason = $5
        WHERE id = $1`,
      [entryId, body.amount, oldAmount, req.user!.id, reason],
    );
    await supersedeEffects(client, entryId, req.user!.id);
    await writeEffects(client, entryId, effects);
    if (before.entry.kind === 'receipt' && !before.entry.link_receipt_id) {
      await client.query(
        'UPDATE project_receipts SET amount = $2 WHERE entry_id = $1 AND voided_at IS NULL',
        [entryId, body.amount],
      );
    }

    const after = await captureEntryState(client, entryId, false);
    if (!after) throw new Error('Corrected entry disappeared inside its offline revision transaction.');
    await writeEntryRevision(client, entryId, txId, 'correction', reason, before, after);
    await persistRevisionClientRef(client, txId, body.clientRef);
    await recordRequired(client, 'financial entry corrected', entryId, {
      from: oldAmount,
      to: body.amount,
      reason,
      clientRef: body.clientRef,
      source: 'offline-sync',
    }, txId, { id: req.user!.id, email: req.user!.email });
    await client.query('COMMIT');
    finished = true;
    res.status(200).json({ ok: true, mode: 'correction', entryId, clientRef: body.clientRef, replay: false });
  } catch (error) {
    if (!finished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

router.post('/entries/:id/void', offlineRevisionLimit, wrap(async (req, res, next) => {
  const candidate = req.body as { offlineContext?: unknown; clientRef?: unknown };
  if (!candidate?.offlineContext || typeof candidate.clientRef !== 'string') return next();
  const body = voidSchema.parse(req.body);
  const entryId = String(req.params.id);
  if (!ownerRequired(req, res, entryId)) return;
  if (body.offlineContext.entry.id !== entryId) {
    return conflict(res, 'target_changed', 'The queued void points at a different entry than its captured context.', entryId, body.offlineContext.entry.id, entryId);
  }

  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offline-revision:${body.clientRef}`]);
    if (await replayOrConflict(client, res, body.clientRef, 'void', entryId, undefined, body.reason)) {
      await client.query(res.statusCode < 400 ? 'COMMIT' : 'ROLLBACK');
      finished = true;
      return;
    }

    const before = await captureEntryState(client, entryId, true);
    if (!before) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'target_missing', 'The entry no longer exists. The offline void was not applied.', entryId, body.offlineContext.entry, null);
    }
    const current = expectationFromState(before);
    if (!sameExpectation(body.offlineContext.entry, current)) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'entry_changed', 'This entry changed while the device was offline. Review the latest entry before voiding it.', entryId, body.offlineContext.entry, current);
    }
    if (before.entry.voided) {
      await client.query('ROLLBACK');
      finished = true;
      return conflict(res, 'entry_changed', 'This entry was already voided by another change.', entryId, body.offlineContext.entry, current);
    }

    const txId = transactionId(req.user!.id, body.clientRef);
    await client.query(
      `UPDATE entries
          SET voided = true,
              void_reason = $2,
              voided_at = now(),
              voided_by = $3
        WHERE id = $1 AND voided = false`,
      [entryId, body.reason, req.user!.id],
    );
    await supersedeEffects(client, entryId, req.user!.id);
    await client.query(
      `UPDATE project_receipts
          SET voided_at = COALESCE(voided_at, now()),
              voided_by = COALESCE(voided_by, $2)
        WHERE entry_id = $1 AND voided_at IS NULL`,
      [entryId, req.user!.id],
    );
    if (before.entry.kind === 'receipt' && before.entry.link_receipt_id) {
      await client.query(
        'UPDATE project_receipts SET in_cash = false WHERE id = $1 AND voided_at IS NULL',
        [before.entry.link_receipt_id],
      );
    }

    const after = await captureEntryState(client, entryId, false);
    if (!after) throw new Error('Voided entry disappeared inside its offline revision transaction.');
    await writeEntryRevision(client, entryId, txId, 'void', body.reason, before, after);
    await persistRevisionClientRef(client, txId, body.clientRef);
    await recordRequired(client, 'financial entry voided', entryId, {
      reason: body.reason,
      amount: Number(before.entry.amount),
      purpose: before.entry.purpose,
      clientRef: body.clientRef,
      source: 'offline-sync',
    }, txId, { id: req.user!.id, email: req.user!.email });
    await client.query('COMMIT');
    finished = true;
    res.status(200).json({ ok: true, mode: 'void', entryId, clientRef: body.clientRef, replay: false });
  } catch (error) {
    if (!finished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

export const offlineRevisionRouter = router;
