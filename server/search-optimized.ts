import { Router, type RequestHandler } from 'express';
import { query } from './db.js';

type DbRow = Record<string, any>;

const router = Router();
const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function boundedLimit(raw: string | null, fallback = 12, max = 25): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

async function assignedAccountIds(userId: string): Promise<string[]> {
  const rows = await query<{ account_id: string }>(
    'SELECT account_id FROM user_accounts WHERE user_id = $1 ORDER BY account_id',
    [userId],
  );
  return rows.map((row) => row.account_id);
}

router.get('/search/entries', wrap(async (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ items: [] });
  const limit = boundedLimit(params.get('limit'));
  const allowedAccounts = req.user?.role === 'owner' ? null : await assignedAccountIds(req.user!.id);
  if (allowedAccounts !== null && allowedAccounts.length === 0) return res.json({ items: [] });

  // Search can match a very large historical set. Order by the existing active
  // recent index so PostgreSQL can stop as soon as it finds the requested page,
  // rather than materializing/sorting every text match before LIMIT.
  const rows = await query<DbRow>(
    `SELECT e.id, e.occurred_on, e.amount, e.purpose, e.raw, e.project_id, e.person_id,
            e.account_id, e.to_account_id,
            a.name AS account_name, p.name AS project_name, pe.name AS person_name
       FROM entries e
       LEFT JOIN accounts a ON a.id = COALESCE(e.account_id, e.to_account_id)
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN people pe ON pe.id = e.person_id
      WHERE e.voided = false
        AND to_tsvector('simple', COALESCE(e.purpose,'') || ' ' || COALESCE(e.raw,''))
            @@ websearch_to_tsquery('simple', $1)
        AND ($2::text[] IS NULL OR e.account_id = ANY($2::text[]) OR e.to_account_id = ANY($2::text[]))
      ORDER BY e.occurred_on DESC, e.created_at DESC, e.id DESC
      LIMIT $3`,
    [q, allowedAccounts, limit],
  );

  res.json({ items: rows.map((row) => {
    const targetType = row.project_id ? 'project' : row.person_id ? 'person' : (row.account_id ?? row.to_account_id) ? 'account' : null;
    const targetId = row.project_id ?? row.person_id ?? row.account_id ?? row.to_account_id ?? null;
    return {
      id: `entry:${row.id}`,
      title: row.purpose || row.raw || 'Entry',
      subtitle: [
        iso(row.occurred_on),
        `$${Number(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        row.account_name || row.project_name || row.person_name,
      ].filter(Boolean).join(' · '),
      targetType,
      targetId,
    };
  }) });
}));

export const optimizedSearchRouter = router;
