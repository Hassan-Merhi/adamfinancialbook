import { Router, type RequestHandler } from 'express';
import { query } from './db.js';

const router = Router();
const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(raw: string | null): string | null {
  if (!raw || !DATE.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function pageLimit(raw: string | null) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 40;
}

type Cursor = { createdAt: string; id: string };
function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return null;
    if (typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 120) return null;
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

router.get('/files-page', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can browse the file library.' });
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return res.status(400).json({ error: 'That file cursor is invalid.' });
  const limit = pageLimit(params.get('limit'));
  const search = (params.get('q') ?? '').trim().slice(0, 120);
  const kind = params.get('kind');
  const source = params.get('source');
  const accountId = (params.get('accountId') ?? '').trim().slice(0, 120);
  const userId = (params.get('userId') ?? '').trim().slice(0, 120);
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const from = rawFrom ? validDate(rawFrom) : null;
  const to = rawTo ? validDate(rawTo) : null;
  if (rawFrom && !from || rawTo && !to) return res.status(400).json({ error: 'Use valid YYYY-MM-DD file dates.' });
  if (kind && !['images', 'pdf'].includes(kind)) return res.status(400).json({ error: 'That file type filter is invalid.' });
  if (source && !['entry', 'approval'].includes(source)) return res.status(400).json({ error: 'That file source filter is invalid.' });

  const values: unknown[] = [];
  const bind = (value: unknown, cast = '') => {
    values.push(value);
    return `$${values.length}${cast}`;
  };
  const filters: string[] = [];
  if (cursor) filters.push(`(a.created_at, a.id) < (${bind(cursor.createdAt, '::timestamptz')}, ${bind(cursor.id)})`);
  if (search) {
    const term = bind(`%${search}%`);
    filters.push(`concat_ws(' ', a.filename, e.purpose, e.raw, ar.request_text, acc.name, eu.email, aru.email) ILIKE ${term}`);
  }
  if (kind === 'images') filters.push(`a.mime_type LIKE 'image/%'`);
  else if (kind === 'pdf') filters.push(`a.mime_type = 'application/pdf'`);
  if (source === 'entry') filters.push('a.entry_id IS NOT NULL');
  else if (source === 'approval') filters.push('a.approval_request_id IS NOT NULL');
  if (accountId) filters.push(`COALESCE(e.account_id, e.to_account_id, ar.account_id) = ${bind(accountId)}`);
  if (userId) filters.push(`COALESCE(e.created_by, ar.created_by, a.uploaded_by) = ${bind(userId)}`);
  if (from) filters.push(`COALESCE(e.occurred_on, ar.created_at::date, a.created_at::date) >= ${bind(from, '::date')}`);
  if (to) filters.push(`COALESCE(e.occurred_on, ar.created_at::date, a.created_at::date) <= ${bind(to, '::date')}`);
  const take = bind(limit + 1, '::int');

  const rows = await query<Record<string, any>>(
    `SELECT a.id, a.filename, a.mime_type, a.byte_size, a.created_at,
            CASE WHEN a.entry_id IS NOT NULL THEN 'entry' ELSE 'approval' END AS source,
            COALESCE(a.entry_id, a.approval_request_id) AS related_id,
            COALESCE(e.occurred_on, ar.created_at::date, a.created_at::date) AS related_date,
            COALESCE(NULLIF(e.purpose, ''), NULLIF(e.raw, ''), ar.request_text, 'Stored evidence') AS description,
            COALESCE(e.amount, ar.amount)::double precision AS amount,
            COALESCE(acc.name, '') AS account_name,
            COALESCE(eu.email, aru.email, up.email, '') AS person,
            COALESCE(e.kind, ar.status, '') AS status
       FROM attachments a
       LEFT JOIN entries e ON e.id = a.entry_id
       LEFT JOIN approval_requests ar ON ar.id = a.approval_request_id
       LEFT JOIN accounts acc ON acc.id = COALESCE(e.account_id, e.to_account_id, ar.account_id)
       LEFT JOIN users eu ON eu.id = e.created_by
       LEFT JOIN users aru ON aru.id = ar.created_by
       LEFT JOIN users up ON up.id = a.uploaded_by
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${take}`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  res.json({
    items: page.map((row) => ({
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      byte_size: Number(row.byte_size),
      created_at: new Date(row.created_at).toISOString(),
      source: row.source,
      relatedId: row.related_id,
      relatedDate: row.related_date ? String(row.related_date).slice(0, 10) : '',
      description: row.description,
      amount: row.amount == null ? null : Number(row.amount),
      accountName: row.account_name,
      person: row.person,
      status: row.status,
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) : null,
  });
}));

export const fileLibraryRouter = router;
