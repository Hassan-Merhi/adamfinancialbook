import { Router, type Request, type RequestHandler } from 'express';
import { query } from './db.js';
import type { Effect, Entry, EntryKind } from '../shared/types.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KINDS = new Set<EntryKind>([
  'expense', 'credit_purchase', 'receipt', 'transfer', 'person_loan', 'salary', 'supplier_payment',
]);

export function boundedLimit(raw: string | null, fallback = 50, max = 100): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function validDate(raw: string | null): string | null {
  if (!raw || !DATE.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

type PageCursor = { date: string; createdAt: string; id: string };
type AuditCursor = { at: string; id: string };

export function encodeCursor(value: PageCursor | AuditCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodePageCursor(raw: string | null): PageCursor | null {
  if (!raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PageCursor>;
    if (!validDate(typeof parsed.date === 'string' ? parsed.date : null)) return null;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return null;
    if (typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 120) return null;
    return { date: parsed.date!, createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

export function decodeAuditCursor(raw: string | null): AuditCursor | null {
  if (!raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<AuditCursor>;
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
    if (typeof parsed.id !== 'string' || !/^\d+$/.test(parsed.id)) return null;
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function isoTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type DbRow = Record<string, any>;

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
    occurredOn: iso(row.occurred_on),
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
    voided: row.voided ?? false,
    voidReason: row.void_reason ?? null,
    voidedAt: isoTime(row.voided_at),
    voidedBy: row.voided_by ?? null,
    createdBy: row.created_by ?? null,
    effects,
    correctedFrom: row.corrected_from == null ? null : Number(row.corrected_from),
    correctedAt: isoTime(row.corrected_at),
    correctedBy: row.corrected_by ?? null,
    correctionReason: row.correction_reason ?? '',
    transactionId: row.transaction_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function assignedAccountIds(req: Request): Promise<string[] | null> {
  if (req.user?.role === 'owner') return null;
  const rows = await query<{ account_id: string }>(
    'SELECT account_id FROM user_accounts WHERE user_id = $1 ORDER BY account_id',
    [req.user!.id],
  );
  return rows.map((row) => row.account_id);
}

async function effectsForEntries(entryIds: string[], allowedAccounts: string[] | null): Promise<Map<string, Effect[]>> {
  const result = new Map<string, Effect[]>();
  if (!entryIds.length) return result;
  const rows = allowedAccounts === null
    ? await query<DbRow>(
      `SELECT entry_id, type, target_id, from_business, to_business, delta
         FROM effects
        WHERE active = true AND entry_id = ANY($1::text[])
        ORDER BY entry_id, id`, [entryIds])
    : allowedAccounts.length
      ? await query<DbRow>(
        `SELECT entry_id, type, target_id, from_business, to_business, delta
           FROM effects
          WHERE active = true
            AND entry_id = ANY($1::text[])
            AND type = 'account'
            AND target_id = ANY($2::text[])
          ORDER BY entry_id, id`, [entryIds, allowedAccounts])
      : [];
  for (const row of rows) {
    const list = result.get(row.entry_id) ?? [];
    list.push(effectFromRow(row));
    result.set(row.entry_id, list);
  }
  return result;
}

interface AggregatedEffect {
  type: string;
  target_id: string | null;
  from_business: string | null;
  to_business: string | null;
  delta: number;
}

async function loadBalanceSnapshot(on: string | null, allowedAccounts: string[] | null, catalogs: {
  accounts: DbRow[];
  projects: DbRow[];
  people: DbRow[];
  loans: DbRow[];
}) {
  const effectRows: AggregatedEffect[] = allowedAccounts === null
    ? await query<AggregatedEffect>(
      `SELECT ef.type, ef.target_id, ef.from_business, ef.to_business,
              SUM(ef.delta)::double precision AS delta
         FROM effects ef
         JOIN entries e ON e.id = ef.entry_id
        WHERE ef.active = true
          AND e.voided = false
          AND ($1::date IS NULL OR e.occurred_on <= $1::date)
        GROUP BY ef.type, ef.target_id, ef.from_business, ef.to_business`, [on])
    : allowedAccounts.length
      ? await query<AggregatedEffect>(
        `SELECT ef.type, ef.target_id, ef.from_business, ef.to_business,
                SUM(ef.delta)::double precision AS delta
           FROM effects ef
           JOIN entries e ON e.id = ef.entry_id
          WHERE ef.active = true
            AND e.voided = false
            AND ef.type = 'account'
            AND ef.target_id = ANY($2::text[])
            AND ($1::date IS NULL OR e.occurred_on <= $1::date)
          GROUP BY ef.type, ef.target_id, ef.from_business, ef.to_business`, [on, allowedAccounts])
      : [];

  const accountMovement = new Map<string, number>();
  const personMovement = new Map<string, number>();
  const projectMovement = new Map<string, number>();
  const loanEffects: AggregatedEffect[] = [];
  for (const row of effectRows) {
    const amount = Number(row.delta);
    if (row.type === 'account' && row.target_id) accountMovement.set(row.target_id, amount);
    else if (row.type === 'person' && row.target_id) personMovement.set(row.target_id, amount);
    else if (row.type === 'project' && row.target_id) projectMovement.set(row.target_id, amount);
    else if (row.type === 'loan') loanEffects.push(row);
  }

  const receiptRows = allowedAccounts === null
    ? await query<{ project_id: string; amount: number }>(
      `SELECT project_id, COALESCE(SUM(amount), 0)::double precision AS amount
         FROM project_receipts
        WHERE voided_at IS NULL
          AND entry_id IS NULL
          AND ($1::date IS NULL OR occurred_on IS NULL OR occurred_on <= $1::date)
        GROUP BY project_id`, [on])
    : [];
  const receiptOpening = new Map(receiptRows.map((row) => [row.project_id, Number(row.amount)]));

  const accounts: Record<string, number> = Object.fromEntries(catalogs.accounts.map((account) => [
    account.id,
    Number(account.opening) + (accountMovement.get(account.id) ?? 0),
  ]));
  const people = allowedAccounts === null ? Object.fromEntries(catalogs.people.map((person) => {
    const moved = personMovement.get(person.id) ?? 0;
    const opening = Number(person.opening);
    const balance = person.kind === 'receivable'
      ? opening + moved
      : person.kind === 'payable'
        ? -(opening + moved)
        : opening + moved - Number(person.salary);
    return [person.id, balance];
  })) : {};
  const projects = allowedAccounts === null ? Object.fromEntries(catalogs.projects.map((project) => [
    project.id,
    (receiptOpening.get(project.id) ?? 0) + (projectMovement.get(project.id) ?? 0),
  ])) : {};
  const loans = allowedAccounts === null ? Object.fromEntries(catalogs.loans.map((loan) => {
    let moved = 0;
    for (const effect of loanEffects) {
      if (effect.from_business === loan.from_business && effect.to_business === loan.to_business) moved += Number(effect.delta);
      else if (effect.from_business === loan.to_business && effect.to_business === loan.from_business) moved -= Number(effect.delta);
    }
    return [loan.id, Number(loan.opening) + moved];
  })) : {};

  const businessTotals: Record<string, number> = {};
  for (const account of catalogs.accounts) {
    if (!account.business_id) continue;
    businessTotals[account.business_id] = (businessTotals[account.business_id] ?? 0) + (accounts[account.id] ?? 0);
  }
  return {
    totalCash: Object.values(accounts).reduce((sum, amount) => sum + amount, 0),
    accounts,
    businesses: businessTotals,
    people,
    loans,
    projects,
  };
}

router.get('/overview', wrap(async (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const rawOn = params.get('on');
  const rawToday = params.get('today');
  const on = rawOn === null ? null : validDate(rawOn);
  const today = validDate(rawToday) ?? new Date().toISOString().slice(0, 10);
  if (rawOn !== null && !on) return res.status(400).json({ error: 'Use a valid YYYY-MM-DD report date.' });
  if (rawToday !== null && !validDate(rawToday)) return res.status(400).json({ error: 'Use a valid YYYY-MM-DD local date.' });

  const allowedAccounts = await assignedAccountIds(req);
  const [businessRows, accountRows, projectRows, peopleRows, loanRows] = await Promise.all([
    query<DbRow>('SELECT id, name FROM businesses ORDER BY created_at'),
    query<DbRow>('SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    query<DbRow>('SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    query<DbRow>('SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    query<DbRow>('SELECT id, from_business, to_business, opening FROM loans'),
  ]);

  const visibleAccountRows = allowedAccounts === null
    ? accountRows
    : accountRows.filter((account) => allowedAccounts.includes(account.id));
  const visibleBusinessIds = new Set(visibleAccountRows.map((account) => account.business_id).filter(Boolean));
  const visibleBusinesses = allowedAccounts === null
    ? businessRows
    : businessRows.filter((business) => visibleBusinessIds.has(business.id));
  const visibleProjects = allowedAccounts === null ? projectRows : [];
  const visiblePeople = allowedAccounts === null ? peopleRows : [];
  const visibleLoans = allowedAccounts === null ? loanRows : [];

  const balances = await loadBalanceSnapshot(on, allowedAccounts, {
    accounts: visibleAccountRows,
    projects: visibleProjects,
    people: visiblePeople,
    loans: visibleLoans,
  });

  let entryRows: DbRow[];
  if (on) {
    entryRows = allowedAccounts === null
      ? await query<DbRow>('SELECT * FROM entries WHERE occurred_on = $1::date ORDER BY occurred_on, created_at, id', [on])
      : allowedAccounts.length
        ? await query<DbRow>(
          `SELECT * FROM entries
            WHERE occurred_on = $1::date
              AND (account_id = ANY($2::text[]) OR to_account_id = ANY($2::text[]))
            ORDER BY occurred_on, created_at, id`, [on, allowedAccounts])
        : [];
  } else {
    entryRows = allowedAccounts === null
      ? await query<DbRow>(
        `WITH chosen AS (
           SELECT id FROM entries WHERE occurred_on = $1::date
           UNION
           SELECT id FROM (
             SELECT id FROM entries
             ORDER BY occurred_on DESC, created_at DESC, id DESC
             LIMIT 40
           ) recent
         )
         SELECT e.* FROM entries e JOIN chosen c ON c.id = e.id
         ORDER BY e.occurred_on, e.created_at, e.id`, [today])
      : allowedAccounts.length
        ? await query<DbRow>(
          `WITH visible AS (
             SELECT * FROM entries
              WHERE account_id = ANY($2::text[]) OR to_account_id = ANY($2::text[])
           ), chosen AS (
             SELECT id FROM visible WHERE occurred_on = $1::date
             UNION
             SELECT id FROM (
               SELECT id FROM visible
               ORDER BY occurred_on DESC, created_at DESC, id DESC
               LIMIT 40
             ) recent
           )
           SELECT e.* FROM visible e JOIN chosen c ON c.id = e.id
           ORDER BY e.occurred_on, e.created_at, e.id`, [today, allowedAccounts])
        : [];
  }
  const effectMap = await effectsForEntries(entryRows.map((entry) => entry.id), allowedAccounts);
  const entries = entryRows.map((entry) => entryFromRow(entry, effectMap.get(entry.id) ?? []));

  const receipts = allowedAccounts === null
    ? await query<DbRow>(
      `SELECT id, project_id, occurred_on, amount, in_cash, entry_id
         FROM project_receipts
        WHERE voided_at IS NULL
          AND (in_cash = false OR entry_id IS NULL)
          AND ($1::date IS NULL OR occurred_on IS NULL OR occurred_on <= $1::date)
        ORDER BY occurred_on, id`, [on])
    : [];
  const reminders = allowedAccounts === null
    ? await query<DbRow>(
      'SELECT id, what, amount, account_id, note, settled FROM reminders WHERE settled = false ORDER BY created_at')
    : [];

  res.json({
    businesses: visibleBusinesses,
    accounts: visibleAccountRows.map((account) => ({
      id: account.id, name: account.name, businessId: account.business_id, opening: Number(account.opening),
    })),
    projects: visibleProjects.map((project) => ({
      id: project.id, name: project.name, scope: project.scope, businessId: project.business_id,
    })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id, projectId: receipt.project_id, occurredOn: iso(receipt.occurred_on),
      amount: Number(receipt.amount), inCash: receipt.in_cash, entryId: receipt.entry_id,
    })),
    people: visiblePeople.map((person) => ({
      id: person.id, name: person.name, role: person.role, businessId: person.business_id,
      kind: person.kind, opening: Number(person.opening), salary: Number(person.salary),
    })),
    loans: visibleLoans.map((loan) => ({
      id: loan.id, fromBusiness: loan.from_business, toBusiness: loan.to_business, opening: Number(loan.opening),
    })),
    entries,
    reminders: reminders.map((reminder) => ({
      id: reminder.id, what: reminder.what, amount: Number(reminder.amount), accountId: reminder.account_id,
      note: reminder.note, settled: reminder.settled,
    })),
    balances,
  });
}));

type TargetType = 'account' | 'person' | 'project' | 'loan';

async function targetOpening(req: Request, type: TargetType, params: URLSearchParams, allowedAccounts: string[] | null) {
  if (type === 'account') {
    const id = params.get('id');
    if (!id) throw Object.assign(new Error('Say which account.'), { status: 400 });
    if (allowedAccounts !== null && !allowedAccounts.includes(id)) throw Object.assign(new Error('That account is not assigned to you.'), { status: 403 });
    const rows = await query<{ opening: number }>('SELECT opening::double precision AS opening FROM accounts WHERE id = $1', [id]);
    if (!rows[0]) throw Object.assign(new Error('No such account.'), { status: 404 });
    return { opening: Number(rows[0].opening), target: { id } };
  }
  if (allowedAccounts !== null) throw Object.assign(new Error('You can only open statements for your assigned accounts.'), { status: 403 });
  if (type === 'person') {
    const id = params.get('id');
    if (!id) throw Object.assign(new Error('Say which person.'), { status: 400 });
    const rows = await query<{ opening: number; salary: number; kind: string }>(
      'SELECT opening::double precision AS opening, salary::double precision AS salary, kind FROM people WHERE id = $1', [id]);
    const person = rows[0];
    if (!person) throw Object.assign(new Error('No such person.'), { status: 404 });
    const opening = person.kind === 'receivable' ? Number(person.opening)
      : person.kind === 'payable' ? -Number(person.opening)
        : Number(person.opening) - Number(person.salary);
    return { opening, target: { id, payable: person.kind === 'payable' } };
  }
  if (type === 'project') {
    const id = params.get('id');
    if (!id) throw Object.assign(new Error('Say which project.'), { status: 400 });
    const exists = await query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [id]);
    if (!exists[0]) throw Object.assign(new Error('No such project.'), { status: 404 });
    const rows = await query<{ opening: number }>(
      `SELECT COALESCE(SUM(amount), 0)::double precision AS opening
         FROM project_receipts WHERE project_id = $1 AND entry_id IS NULL AND voided_at IS NULL`, [id]);
    return { opening: Number(rows[0]?.opening ?? 0), target: { id } };
  }
  const fromBusiness = params.get('fromBusiness');
  const toBusiness = params.get('toBusiness');
  const view = params.get('view');
  if (!fromBusiness || !toBusiness || !view) throw Object.assign(new Error('Say which business loan.'), { status: 400 });
  const rows = await query<{ from_business: string; to_business: string; opening: number }>(
    `SELECT from_business, to_business, opening::double precision AS opening FROM loans
      WHERE (from_business = $1 AND to_business = $2) OR (from_business = $2 AND to_business = $1)
      LIMIT 1`, [fromBusiness, toBusiness]);
  const loan = rows[0];
  if (!loan) throw Object.assign(new Error('No such loan.'), { status: 404 });
  let raw = loan.from_business === fromBusiness ? Number(loan.opening) : -Number(loan.opening);
  if (view === fromBusiness) raw = -raw;
  return { opening: raw, target: { fromBusiness, toBusiness, view } };
}

router.get('/statement-page', wrap(async (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const type = params.get('type') as TargetType | null;
  if (!type || !['account', 'person', 'project', 'loan'].includes(type)) {
    return res.status(400).json({ error: 'Choose an account, person, project or loan.' });
  }
  const limit = boundedLimit(params.get('limit'), 50, 100);
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodePageCursor(rawCursor) : null;
  if (rawCursor && !cursor) return res.status(400).json({ error: 'That page cursor is invalid.' });
  const q = (params.get('q') ?? '').trim().slice(0, 120);
  const rawKind = params.get('kind');
  const kind = rawKind && ENTRY_KINDS.has(rawKind as EntryKind) ? rawKind : null;
  if (rawKind && !kind) return res.status(400).json({ error: 'That entry type is invalid.' });
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const from = rawFrom ? validDate(rawFrom) : null;
  const to = rawTo ? validDate(rawTo) : null;
  if (rawFrom && !from || rawTo && !to) return res.status(400).json({ error: 'Use valid YYYY-MM-DD statement dates.' });

  const allowedAccounts = await assignedAccountIds(req);
  const opened = await targetOpening(req, type, params, allowedAccounts);
  const values: unknown[] = [];
  const bind = (value: unknown, cast = '') => {
    values.push(value);
    return `$${values.length}${cast}`;
  };
  const openingParam = bind(opened.opening, '::double precision');
  let effectSql = '';
  if (type === 'account') {
    const id = bind((opened.target as { id: string }).id);
    effectSql = `SELECT entry_id, SUM(delta)::double precision AS delta FROM effects
      WHERE active = true AND type = 'account' AND target_id = ${id} GROUP BY entry_id`;
  } else if (type === 'person') {
    const target = opened.target as { id: string; payable: boolean };
    const id = bind(target.id);
    const sign = target.payable ? -1 : 1;
    effectSql = `SELECT entry_id, (SUM(delta) * ${sign})::double precision AS delta FROM effects
      WHERE active = true AND type = 'person' AND target_id = ${id} GROUP BY entry_id`;
  } else if (type === 'project') {
    const id = bind((opened.target as { id: string }).id);
    effectSql = `SELECT entry_id,
      SUM(CASE WHEN type = 'project' THEN delta WHEN type = 'cost' THEN -delta ELSE 0 END)::double precision AS delta
      FROM effects WHERE active = true AND target_id = ${id} AND type IN ('project','cost') GROUP BY entry_id`;
  } else {
    const target = opened.target as { fromBusiness: string; toBusiness: string; view: string };
    const fromBusiness = bind(target.fromBusiness);
    const toBusiness = bind(target.toBusiness);
    const sign = target.view === target.fromBusiness ? -1 : 1;
    effectSql = `SELECT entry_id,
      (SUM(CASE
        WHEN from_business = ${fromBusiness} AND to_business = ${toBusiness} THEN delta
        WHEN from_business = ${toBusiness} AND to_business = ${fromBusiness} THEN -delta
        ELSE 0 END) * ${sign})::double precision AS delta
      FROM effects WHERE active = true AND type = 'loan'
        AND ((from_business = ${fromBusiness} AND to_business = ${toBusiness})
          OR (from_business = ${toBusiness} AND to_business = ${fromBusiness}))
      GROUP BY entry_id`;
  }

  const filters: string[] = [];
  if (q) {
    const search = bind(q);
    filters.push(`to_tsvector('simple', COALESCE(purpose,'') || ' ' || COALESCE(raw,'')) @@ websearch_to_tsquery('simple', ${search})`);
  }
  if (kind) filters.push(`kind = ${bind(kind)}`);
  if (from) filters.push(`occurred_on >= ${bind(from, '::date')}`);
  if (to) filters.push(`occurred_on <= ${bind(to, '::date')}`);
  const cursorFilter = cursor
    ? `(occurred_on, created_at, id) < (${bind(cursor.date, '::date')}, ${bind(cursor.createdAt, '::timestamptz')}, ${bind(cursor.id)})`
    : 'true';
  const take = bind(limit + 1, '::int');

  const rows = await query<DbRow>(
    `WITH target_effects AS (${effectSql}),
     ledger AS (
       SELECT e.*, te.delta,
              ${openingParam} + SUM(te.delta) OVER (ORDER BY e.occurred_on, e.created_at, e.id) AS running
         FROM target_effects te
         JOIN entries e ON e.id = te.entry_id
        WHERE e.voided = false
     ), filtered AS (
       SELECT *, COUNT(*) OVER()::int AS total_count,
              COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) OVER(), 0)::double precision AS in_sum,
              COALESCE(SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END) OVER(), 0)::double precision AS out_sum
         FROM ledger
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
     )
     SELECT * FROM filtered
      WHERE ${cursorFilter}
      ORDER BY occurred_on DESC, created_at DESC, id DESC
      LIMIT ${take}`,
    values,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const effectMap = await effectsForEntries(pageRows.map((row) => row.id), allowedAccounts);
  const items = pageRows.map((row) => ({
    entry: entryFromRow(row, effectMap.get(row.id) ?? []),
    delta: Number(row.delta),
    running: Number(row.running),
  }));
  const last = pageRows.at(-1);
  res.json({
    items,
    nextCursor: hasMore && last ? encodeCursor({
      date: iso(last.occurred_on), createdAt: new Date(last.created_at).toISOString(), id: last.id,
    }) : null,
    total: Number(pageRows[0]?.total_count ?? 0),
    inSum: Number(pageRows[0]?.in_sum ?? 0),
    outSum: Number(pageRows[0]?.out_sum ?? 0),
  });
}));

router.get('/search/entries', wrap(async (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ items: [] });
  const limit = boundedLimit(params.get('limit'), 12, 25);
  const allowedAccounts = await assignedAccountIds(req);
  if (allowedAccounts !== null && !allowedAccounts.length) return res.json({ items: [] });
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
      ORDER BY
        CASE WHEN lower(e.purpose) = lower($1) THEN 0 WHEN lower(e.purpose) LIKE lower($1) || '%' THEN 1 ELSE 2 END,
        e.occurred_on DESC, e.created_at DESC, e.id DESC
      LIMIT $3`, [q, allowedAccounts, limit]);
  res.json({ items: rows.map((row) => {
    const targetType = row.project_id ? 'project' : row.person_id ? 'person' : (row.account_id ?? row.to_account_id) ? 'account' : null;
    const targetId = row.project_id ?? row.person_id ?? row.account_id ?? row.to_account_id ?? null;
    return {
      id: `entry:${row.id}`,
      title: row.purpose || row.raw || 'Entry',
      subtitle: [iso(row.occurred_on), `$${Number(row.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        row.account_name || row.project_name || row.person_name].filter(Boolean).join(' · '),
      targetType,
      targetId,
    };
  }) });
}));

router.get('/history-page', wrap(async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can read the audit trail.' });
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const limit = boundedLimit(params.get('limit'), 50, 100);
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodeAuditCursor(rawCursor) : null;
  if (rawCursor && !cursor) return res.status(400).json({ error: 'That history cursor is invalid.' });
  const rows = await query<DbRow>(
    `SELECT id, at, actor_email, action, subject, detail, transaction_id
       FROM audit
      WHERE ($1::timestamptz IS NULL OR (at, id) < ($1::timestamptz, $2::bigint))
      ORDER BY at DESC, id DESC
      LIMIT $3`, [cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  res.json({
    lines: page.map((row) => ({
      id: String(row.id), at: new Date(row.at).toISOString(), actorEmail: row.actor_email,
      action: row.action, subject: row.subject, detail: row.detail ?? {}, transactionId: row.transaction_id,
    })),
    nextCursor: hasMore && last ? encodeCursor({ at: new Date(last.at).toISOString(), id: String(last.id) }) : null,
  });
}));

export const performanceRouter = router;
