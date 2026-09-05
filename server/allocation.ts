import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { record } from './audit.js';
import { loadBook } from './book.js';
import { newId, pool, query } from './db.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Effect } from '../shared/types.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function ownerOnly(req: Request, res: Response): boolean {
  if (req.user?.role === 'owner') return true;
  res.status(403).json({ error: 'Only the owner can allocate delegated spending.' });
  return false;
}

export interface DelegatedSpendRow {
  id: string;
  occurred_on: string;
  amount: number;
  purpose: string;
  account_id: string;
  account_name: string;
  payer_business_id: string;
  project_id: string | null;
  for_business: string | null;
  spender_email: string;
  created_at: string;
}

router.get('/allocation/spending', wrap(async (req, res) => {
  if (!ownerOnly(req, res)) return;

  const rows = await query<DelegatedSpendRow>(
    `SELECT e.id, e.occurred_on, e.amount, e.purpose, e.account_id,
            a.name AS account_name, a.business_id AS payer_business_id,
            e.project_id, e.for_business, u.email AS spender_email, e.created_at
       FROM entries e
       JOIN users u ON u.id = e.created_by AND u.role = 'entry'
       JOIN accounts a ON a.id = e.account_id
      WHERE e.kind = 'expense' AND e.voided = false
      ORDER BY e.occurred_on DESC, e.created_at DESC
      LIMIT 1000`);

  res.json({ items: rows });
}));

router.post('/allocation/spending', wrap(async (req, res) => {
  if (!ownerOnly(req, res)) return;

  const body = z.object({
    entryIds: z.array(z.string().min(1)).min(1).max(500),
    businessId: z.string().min(1),
    projectId: z.string().min(1).nullish(),
  }).parse(req.body);

  const entryIds = [...new Set(body.entryIds)];
  const business = await query<{ id: string; name: string }>(
    'SELECT id, name FROM businesses WHERE id = $1', [body.businessId]);
  if (!business[0]) return res.status(404).json({ error: 'That business no longer exists.' });

  if (body.projectId) {
    const project = await query<{ id: string; business_id: string }>(
      'SELECT id, business_id FROM projects WHERE id = $1', [body.projectId]);
    if (!project[0]) return res.status(404).json({ error: 'That project no longer exists.' });
    if (project[0].business_id !== body.businessId) {
      return res.status(400).json({ error: 'That project belongs to a different business.' });
    }
  }

  const book = await loadBook();
  const byId = new Map(book.entries.map((entry) => [entry.id, entry]));
  const client = await pool.connect();
  let total = 0;

  try {
    await client.query('BEGIN');

    const locked = await client.query<{ id: string; account_id: string }>(
      `SELECT e.id, e.account_id
         FROM entries e
         JOIN users u ON u.id = e.created_by AND u.role = 'entry'
        WHERE e.id = ANY($1::text[]) AND e.kind = 'expense' AND e.voided = false
        FOR UPDATE`, [entryIds]);

    if (locked.rowCount !== entryIds.length) {
      throw Object.assign(new Error('One or more selected expenses are missing, voided, or were not logged by a delegated user.'), { status: 409 });
    }

    for (const row of locked.rows) {
      const entry = byId.get(row.id);
      if (!entry) {
        throw Object.assign(new Error('One of the selected expenses could not be loaded. Refresh and try again.'), { status: 409 });
      }

      const payerBusiness = book.accounts.find((account) => account.id === row.account_id)?.businessId ?? null;
      if (payerBusiness && payerBusiness !== body.businessId) {
        const existing = await client.query(
          `SELECT id FROM loans
            WHERE (from_business = $1 AND to_business = $2)
               OR (from_business = $2 AND to_business = $1)`,
          [payerBusiness, body.businessId]);
        if (existing.rowCount === 0) {
          await client.query(
            'INSERT INTO loans (id, from_business, to_business, opening) VALUES ($1,$2,$3,0)',
            [newId('loan'), payerBusiness, body.businessId]);
        }
      }

      const effects = withLoanEffects({
        occurredOn: entry.occurredOn,
        kind: entry.kind,
        amount: entry.amount,
        purpose: entry.purpose,
        raw: entry.raw,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        projectId: body.projectId ?? null,
        personId: entry.personId,
        forBusiness: body.businessId,
        historical: entry.historical,
        linkReceiptId: entry.linkReceiptId,
        clientRef: entry.clientRef,
      }, book);

      await client.query(
        'UPDATE entries SET project_id = $2, for_business = $3 WHERE id = $1',
        [entry.id, body.projectId ?? null, body.businessId]);
      await client.query('DELETE FROM effects WHERE entry_id = $1', [entry.id]);
      await writeEffects(client, entry.id, effects);
      total += Number(entry.amount);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await record(req, 'delegated spending allocated', body.projectId ?? body.businessId, {
    entryIds,
    count: entryIds.length,
    total,
    businessId: body.businessId,
    projectId: body.projectId ?? null,
  });

  res.json({ ok: true, count: entryIds.length, total });
}));

async function writeEffects(client: PoolClient, entryId: string, effects: Effect[]) {
  for (const effect of effects) {
    await client.query(
      `INSERT INTO effects (entry_id, type, target_id, from_business, to_business, delta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entryId, effect.type, effect.targetId ?? null, effect.fromBusiness ?? null, effect.toBusiness ?? null, effect.delta]);
  }
}

export const allocationGate = router;
