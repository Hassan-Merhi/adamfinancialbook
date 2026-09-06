import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Effect } from '../shared/types.js';
import { recordRequired } from './audit.js';
import { writeEffects } from './book.js';
import { newId, pool } from './db.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Confirmation is a protected financial mutation. Bound repeated attempts so a
// compromised delegated session cannot hammer the PostgreSQL write-lock path.
const handoffConfirmationLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

type TransferRow = {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: number | string;
  purpose: string;
  occurred_on: Date | string;
  requested_by: string;
  recipient_user_id: string;
  status: 'pending' | 'confirmed' | 'rejected';
  entry_id: string | null;
  to_account_name: string;
};

type AccountRow = {
  id: string;
  name: string;
  business_id: string | null;
  opening: number | string;
};

function day(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function ensureLoanPair(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null }> },
  fromBusiness: string,
  toBusiness: string,
): Promise<void> {
  if (fromBusiness === toBusiness) return;
  const existing = await client.query(
    `SELECT id FROM loans
      WHERE (from_business = $1 AND to_business = $2)
         OR (from_business = $2 AND to_business = $1)`,
    [fromBusiness, toBusiness],
  );
  if (!existing.rowCount) {
    await client.query(
      'INSERT INTO loans (id, from_business, to_business, opening) VALUES ($1,$2,$3,0)',
      [newId('loan'), fromBusiness, toBusiness],
    );
  }
}

/**
 * Confirmation is itself a financial write. The old flow checked funds when the
 * owner created the handoff, then posted later without re-checking atomically.
 * Phase 4 serializes confirmation against every entry INSERT and makes the
 * current committed server balance the final authority.
 */
router.post('/delegation/transfers/:id/confirm', handoffConfirmationLimit, wrap(async (req, res) => {
  if (req.user?.role !== 'entry') {
    return res.status(403).json({ error: 'This confirmation belongs to the recipient.' });
  }

  const id = String(req.params.id);
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('BEGIN');
    // SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock taken by an
    // ordinary entry INSERT. This closes the gap between balance validation and
    // posting without blocking normal read-only dashboard traffic.
    await client.query(`LOCK TABLE
      entries, effects, accounts, businesses, loans, pending_transfers
      IN SHARE ROW EXCLUSIVE MODE`);

    const transferResult = await client.query<TransferRow>(
      `SELECT pt.*, a2.name AS to_account_name
         FROM pending_transfers pt
         JOIN accounts a2 ON a2.id = pt.to_account_id
        WHERE pt.id = $1 AND pt.recipient_user_id = $2
        FOR UPDATE OF pt`,
      [id, req.user.id],
    );
    const transfer = transferResult.rows[0];
    if (!transfer) {
      await client.query('ROLLBACK');
      finished = true;
      return res.status(404).json({ error: 'No such transfer.' });
    }
    if (transfer.status !== 'pending') {
      await client.query('ROLLBACK');
      finished = true;
      return res.status(409).json({ error: `This transfer is already ${transfer.status}.` });
    }

    const amount = Number(transfer.amount);
    const accounts = await client.query<AccountRow>(
      `SELECT id, name, business_id, opening
         FROM accounts WHERE id = ANY($1::text[])`,
      [[transfer.from_account_id, transfer.to_account_id]],
    );
    const source = accounts.rows.find((row) => row.id === transfer.from_account_id);
    const destination = accounts.rows.find((row) => row.id === transfer.to_account_id);
    if (!source || !destination) {
      await client.query('ROLLBACK');
      finished = true;
      return res.status(409).json({
        error: 'One of the handoff accounts no longer exists. Nothing was posted.',
        code: 'OFFLINE_CONFLICT_TARGET_MISSING',
      });
    }

    const clientRef = `handoff_${id}`;
    const existing = await client.query<{
      id: string;
      kind: string;
      amount: number | string;
      purpose: string;
      account_id: string | null;
      to_account_id: string | null;
    }>(
      `SELECT id, kind, amount, purpose, account_id, to_account_id
         FROM entries WHERE client_ref = $1`,
      [clientRef],
    );
    const prior = existing.rows[0];
    if (prior) {
      const same = prior.kind === 'transfer'
        && Math.abs(Number(prior.amount) - amount) < 0.005
        && prior.purpose === transfer.purpose
        && prior.account_id === transfer.from_account_id
        && prior.to_account_id === transfer.to_account_id;
      if (!same) {
        await client.query('ROLLBACK');
        finished = true;
        return res.status(409).json({
          error: 'This handoff reference is already attached to a different financial entry.',
          code: 'OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED',
        });
      }
      await client.query(
        `UPDATE pending_transfers
            SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), entry_id = $2
          WHERE id = $1 AND status = 'pending'`,
        [id, prior.id],
      );
      await client.query('COMMIT');
      finished = true;
      return res.json({ ok: true, entryId: prior.id });
    }

    const balanceResult = await client.query<{ balance: number | string }>(
      `SELECT a.opening + COALESCE((
          SELECT SUM(e.delta)
            FROM effects e
           WHERE e.active = true AND e.type = 'account' AND e.target_id = a.id
        ), 0) AS balance
         FROM accounts a
        WHERE a.id = $1`,
      [source.id],
    );
    const available = Number(balanceResult.rows[0]?.balance ?? 0);
    if (amount > available + 0.0001) {
      await client.query('ROLLBACK');
      finished = true;
      return res.status(409).json({
        error: `This handoff can no longer be posted — the source account has $${available.toFixed(2)}, not $${amount.toFixed(2)}. The transfer is still pending for review.`,
        code: 'OFFLINE_CONFLICT_INSUFFICIENT_FUNDS',
        details: {
          kind: 'insufficient_funds',
          targetId: source.id,
          expected: { required: amount },
          current: { balance: available },
          detectedAt: new Date().toISOString(),
        },
      });
    }

    if (source.business_id && destination.business_id && source.business_id !== destination.business_id) {
      await ensureLoanPair(client, source.business_id, destination.business_id);
    }

    const entryId = newId('ent');
    const transactionId = newId('txn');
    await client.query(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
         project_id, person_id, for_business, historical, link_receipt_id,
         client_ref, created_by, transaction_id
       ) VALUES ($1,$2,'transfer',$3,$4,$5,$6,$7,NULL,NULL,NULL,false,NULL,$8,$9,$10)`,
      [
        entryId,
        day(transfer.occurred_on),
        amount,
        transfer.purpose,
        `Confirmed cash handoff: ${transfer.purpose}`,
        source.id,
        destination.id,
        clientRef,
        transfer.requested_by,
        transactionId,
      ],
    );

    // Migration 004's entries_confirm_handoff trigger is the canonical atomic
    // handoff-state transition. Verify that it linked this exact pending row
    // instead of attempting a second status update that would fight the trigger.
    const confirmedResult = await client.query<{ status: string; entry_id: string | null }>(
      'SELECT status, entry_id FROM pending_transfers WHERE id = $1 FOR UPDATE',
      [id],
    );
    const confirmed = confirmedResult.rows[0];
    if (!confirmed || confirmed.status !== 'confirmed' || confirmed.entry_id !== entryId) {
      throw new Error('The handoff confirmation trigger did not link the new financial entry.');
    }

    const effects: Effect[] = [
      { type: 'account', targetId: source.id, delta: -amount },
      { type: 'account', targetId: destination.id, delta: amount },
    ];
    if (source.business_id && destination.business_id && source.business_id !== destination.business_id) {
      effects.push({
        type: 'loan',
        fromBusiness: source.business_id,
        toBusiness: destination.business_id,
        delta: -amount,
      });
    }
    await writeEffects(client, entryId, effects);
    await recordRequired(
      client,
      'financial entry posted',
      entryId,
      {
        amount,
        kind: 'transfer',
        purpose: transfer.purpose,
        occurredOn: day(transfer.occurred_on),
        clientRef,
        createdBy: transfer.requested_by,
        source: 'delegated-handoff-confirmation',
      },
      transactionId,
    );

    const owners = await client.query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
    for (const owner of owners.rows) {
      await client.query(
        `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
         VALUES ($1,$2,'transfer_confirmed',$3,$4,'transfer',$5)`,
        [
          newId('ntf'),
          owner.id,
          `${req.user.email} confirmed $${amount.toFixed(2)}`,
          `Money is now posted into ${transfer.to_account_name}.`,
          id,
        ],
      );
    }
    await recordRequired(
      client,
      'delegated transfer confirmed',
      id,
      { entryId, amount, sourceBalanceBefore: available, sourceBalanceAfter: available - amount },
      transactionId,
    );

    await client.query('COMMIT');
    finished = true;
    return res.json({ ok: true, entryId });
  } catch (error) {
    if (!finished) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

export const handoffConfirmationSafetyRouter = router;
