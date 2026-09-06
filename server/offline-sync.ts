import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { accountBalance } from '../shared/engine.js';
import { recordRequired } from './audit.js';
import { newId, pool, query } from './db.js';
import { loadBook } from './book.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// This endpoint can perform several reads/writes while reconciling an uncertain
// offline retry. Keep it below the app-wide 300/min ceiling as an additional
// database-write guard. 429 remains a retryable Phase 3 state, so a legitimate
// reconnect burst is delayed rather than dropped.
const offlineHandoffLimit = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const bodySchema = z.object({
  fromAccountId: z.string(),
  toAccountId: z.string(),
  amount: z.number().positive(),
  purpose: z.string().default('Cash handoff'),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clientRef: z.string().min(1).max(80),
});

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

function deterministicHandoffId(userId: string, clientRef: string): string {
  const digest = createHash('sha256')
    .update(userId)
    .update('\0')
    .update(clientRef)
    .digest('hex')
    .slice(0, 32);
  return `xfr_sync_${digest}`;
}

function day(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function sameRequest(
  row: HandoffRow,
  body: z.infer<typeof bodySchema>,
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

async function existingHandoff(id: string): Promise<HandoffRow | null> {
  const rows = await query<HandoffRow>(
    `SELECT id, from_account_id, to_account_id, amount, purpose, occurred_on,
            requested_by, recipient_user_id, status
       FROM pending_transfers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Phase 3 interception for offline/retried delegated handoffs.
 *
 * The existing route remains authoritative for ordinary requests that do not
 * carry a clientRef. A clientRef makes the handoff id deterministic, so a
 * request whose response was lost can be repeated without creating a second
 * pending transfer, notification or audit line.
 */
router.post('/delegation/transfers', offlineHandoffLimit, wrap(async (req, res, next) => {
  const candidate = req.body as { clientRef?: unknown };
  if (typeof candidate?.clientRef !== 'string' || !candidate.clientRef) return next();
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can send delegated funds.' });

  const body = bodySchema.parse(req.body);
  if (body.fromAccountId === body.toAccountId) return res.status(400).json({ error: 'Choose two different accounts.' });

  const id = deterministicHandoffId(req.user.id, body.clientRef);
  const existing = await existingHandoff(id);
  if (existing) {
    if (!sameRequest(existing, body, req.user.id)) {
      return res.status(409).json({
        error: 'That offline idempotency key was already used for a different cash handoff.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return res.status(200).json({ id: existing.id, status: existing.status });
  }

  const assignments = await query<AssignmentRow>(
    `SELECT ua.user_id, u.email, a.name AS account_name
       FROM user_accounts ua
       JOIN users u ON u.id = ua.user_id
       JOIN accounts a ON a.id = ua.account_id
      WHERE ua.account_id = $1`,
    [body.toAccountId],
  );
  const assignment = assignments[0];
  if (!assignment) return res.status(400).json({ error: 'The destination must be assigned to a delegated user.' });

  const book = await loadBook();
  const source = book.accounts.find((account) => account.id === body.fromAccountId);
  if (!source) return res.status(400).json({ error: 'The source account does not exist.' });
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
       ON CONFLICT (id) DO NOTHING
       RETURNING id, status`,
      [id, body.fromAccountId, body.toAccountId, body.amount, body.purpose, body.occurredOn, req.user.id, assignment.user_id],
    );

    if (!inserted.rows[0]) {
      const duplicate = await client.query<HandoffRow>(
        `SELECT id, from_account_id, to_account_id, amount, purpose, occurred_on,
                requested_by, recipient_user_id, status
           FROM pending_transfers WHERE id = $1`,
        [id],
      );
      const row = duplicate.rows[0];
      if (!row || !sameRequest(row, body, req.user.id, assignment.user_id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'That offline idempotency key was already used for a different cash handoff.',
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      await client.query('COMMIT');
      return res.status(200).json({ id: row.id, status: row.status });
    }

    await client.query(
      `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId('ntf'),
        assignment.user_id,
        'transfer_waiting',
        `$${body.amount.toFixed(2)} sent to ${assignment.account_name}`,
        `${req.user.email} says this money was transferred. Confirm only after you actually receive it.`,
        'transfer',
        id,
      ],
    );
    await recordRequired(
      client,
      'delegated transfer awaiting confirmation',
      id,
      {
        fromAccountId: body.fromAccountId,
        toAccountId: body.toAccountId,
        amount: body.amount,
        purpose: body.purpose,
        occurredOn: body.occurredOn,
        recipient: assignment.email,
        clientRef: body.clientRef,
      },
    );
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