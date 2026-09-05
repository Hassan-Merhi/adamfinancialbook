import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { pool, query } from './db.js';
import { loadBook } from './book.js';
import { record } from './audit.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Effect, EntryInput } from '../shared/types.js';

export const expenseReviewRouter = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

interface ReviewRow {
  id: string;
  occurred_on: string;
  kind: 'expense';
  amount: number;
  purpose: string;
  raw: string;
  account_id: string;
  to_account_id: string | null;
  person_id: string | null;
  historical: boolean;
  link_receipt_id: string | null;
  client_ref: string | null;
  created_at: Date;
  created_by: string;
  actor_email: string;
  account_name: string;
  payer_business_id: string;
  payer_business_name: string;
}

/**
 * Expenses entered by delegated users are already real cash movements. They
 * stay here until an owner says which business/project they belong to.
 */
expenseReviewRouter.get('/delegation/expense-reviews', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.json({ items: [] });

  const items = await query<ReviewRow>(
    `SELECT e.id, e.occurred_on, e.kind, e.amount, e.purpose, e.raw,
            e.account_id, e.to_account_id, e.person_id, e.historical,
            e.link_receipt_id, e.client_ref, e.created_at, e.created_by,
            u.email AS actor_email, a.name AS account_name,
            a.business_id AS payer_business_id, b.name AS payer_business_name
       FROM entries e
       JOIN users u ON u.id = e.created_by AND u.role = 'entry'
       JOIN accounts a ON a.id = e.account_id
       JOIN businesses b ON b.id = a.business_id
      WHERE e.kind = 'expense'
        AND e.voided = false
        AND e.reviewed_at IS NULL
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT 500`);

  res.json({
    items: items.map((item) => ({
      ...item,
      occurred_on: String(item.occurred_on).slice(0, 10),
      created_at: new Date(item.created_at).toISOString(),
    })),
  });
}));

const assignment = z.object({
  entryIds: z.array(z.string().min(1)).min(1).max(200),
  businessId: z.string().min(1),
  projectId: z.string().min(1).nullish(),
  category: z.string().trim().max(80).default(''),
});

/**
 * Classify one or many delegated expenses without posting cash a second time.
 * We replace the original effect set in one transaction: the account effect is
 * recreated exactly once, while project cost / intercompany effects are added
 * from the owner's classification.
 */
expenseReviewRouter.post('/delegation/expense-reviews/assign', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can assign delegated expenses.' });
  }

  const body = assignment.parse(req.body);
  const entryIds = [...new Set(body.entryIds)];
  const book = await loadBook();
  const business = book.businesses.find((item) => item.id === body.businessId);
  if (!business) return res.status(400).json({ error: 'Choose a business that still exists.' });

  const project = body.projectId ? book.projects.find((item) => item.id === body.projectId) : null;
  if (body.projectId && !project) return res.status(400).json({ error: 'Choose a project that still exists.' });
  if (project && project.businessId !== business.id) {
    return res.status(400).json({ error: 'That project belongs to a different business.' });
  }

  const client = await pool.connect();
  let rows: ReviewRow[] = [];
  try {
    await client.query('BEGIN');
    const locked = await client.query<ReviewRow>(
      `SELECT e.id, e.occurred_on, e.kind, e.amount, e.purpose, e.raw,
              e.account_id, e.to_account_id, e.person_id, e.historical,
              e.link_receipt_id, e.client_ref, e.created_at, e.created_by,
              u.email AS actor_email, a.name AS account_name,
              a.business_id AS payer_business_id, b.name AS payer_business_name
         FROM entries e
         JOIN users u ON u.id = e.created_by AND u.role = 'entry'
         JOIN accounts a ON a.id = e.account_id
         JOIN businesses b ON b.id = a.business_id
        WHERE e.id = ANY($1::text[])
          AND e.kind = 'expense'
          AND e.voided = false
          AND e.reviewed_at IS NULL
        FOR UPDATE OF e`,
      [entryIds],
    );
    rows = locked.rows;

    if (rows.length !== entryIds.length) {
      throw Object.assign(
        new Error('One or more expenses were already assigned, voided, or are not delegated expenses. Refresh and try again.'),
        { status: 409 },
      );
    }

    for (const row of rows) {
      const input: EntryInput = {
        occurredOn: String(row.occurred_on).slice(0, 10),
        kind: 'expense',
        amount: Number(row.amount),
        purpose: row.purpose,
        raw: row.raw,
        accountId: row.account_id,
        toAccountId: null,
        projectId: project?.id ?? null,
        personId: null,
        forBusiness: business.id,
        historical: row.historical,
        linkReceiptId: null,
        clientRef: row.client_ref,
      };
      const effects = withLoanEffects(input, book);

      const updated = await client.query(
        `UPDATE entries
            SET project_id = $2,
                person_id = NULL,
                for_business = $3,
                review_category = $4,
                reviewed_by = $5,
                reviewed_at = now()
          WHERE id = $1 AND reviewed_at IS NULL`,
        [row.id, project?.id ?? null, business.id, body.category, req.user!.id],
      );
      if (updated.rowCount !== 1) {
        throw Object.assign(new Error('That expense changed while you were assigning it. Refresh and try again.'), { status: 409 });
      }

      await client.query('DELETE FROM effects WHERE entry_id = $1', [row.id]);
      await writeEffects(client, row.id, effects);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // The expense notification has now been acted on for this owner.
  await query(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, now())
      WHERE user_id = $1
        AND related_type = 'entry'
        AND related_id = ANY($2::text[])`,
    [req.user.id, entryIds],
  );

  await record(
    req,
    entryIds.length === 1 ? 'delegated expense assigned' : 'delegated expenses assigned',
    entryIds.length === 1 ? entryIds[0] : `batch:${entryIds.length}`,
    {
      entryIds,
      businessId: business.id,
      business: business.name,
      projectId: project?.id ?? null,
      project: project?.name ?? null,
      category: body.category,
      totalAmount: rows.reduce((sum, row) => sum + Number(row.amount), 0),
    },
  );

  res.json({ ok: true, count: entryIds.length });
}));

async function writeEffects(client: import('pg').PoolClient, entryId: string, effects: Effect[]) {
  for (const effect of effects) {
    await client.query(
      `INSERT INTO effects (entry_id, type, target_id, from_business, to_business, delta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entryId,
        effect.type,
        effect.targetId ?? null,
        effect.fromBusiness ?? null,
        effect.toBusiness ?? null,
        effect.delta,
      ],
    );
  }
}
