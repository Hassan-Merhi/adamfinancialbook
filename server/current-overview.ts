import { Router, type RequestHandler } from 'express';
import { query } from './db.js';
import { getCurrentBalanceEffects, type CachedAggregatedEffect } from './current-balance-cache.js';
import type { Effect, Entry } from '../shared/types.js';

const router = Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type DbRow = Record<string, any>;
type AggregatedEffect = CachedAggregatedEffect;

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validDate(raw: string | null): string | null {
  if (!raw || !DATE.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function isoTime(value: Date | string | null | undefined): string | null {
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

function entryFromRow(row: DbRow, effects: Effect[]): Entry {
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

async function effectsForEntries(entryIds: string[]): Promise<Map<string, Effect[]>> {
  const result = new Map<string, Effect[]>();
  if (!entryIds.length) return result;
  const rows = await query<DbRow>(
    `SELECT entry_id, type, target_id, from_business, to_business, delta
       FROM effects
      WHERE active = true AND entry_id = ANY($1::text[])
      ORDER BY entry_id, id`,
    [entryIds],
  );
  for (const row of rows) {
    const list = result.get(row.entry_id) ?? [];
    list.push(effectFromRow(row));
    result.set(row.entry_id, list);
  }
  return result;
}

function buildBalances(
  effectRows: AggregatedEffect[],
  receiptRows: { project_id: string; amount: number }[],
  accountsCatalog: DbRow[],
  projectsCatalog: DbRow[],
  peopleCatalog: DbRow[],
  loansCatalog: DbRow[],
) {
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

  const receiptOpening = new Map(receiptRows.map((row) => [row.project_id, Number(row.amount)]));
  const accounts: Record<string, number> = Object.fromEntries(accountsCatalog.map((account) => [
    account.id,
    Number(account.opening) + (accountMovement.get(account.id) ?? 0),
  ]));
  const people = Object.fromEntries(peopleCatalog.map((person) => {
    const moved = personMovement.get(person.id) ?? 0;
    const opening = Number(person.opening);
    const balance = person.kind === 'receivable'
      ? opening + moved
      : person.kind === 'payable'
        ? -(opening + moved)
        : opening + moved - Number(person.salary);
    return [person.id, balance];
  }));
  const projects = Object.fromEntries(projectsCatalog.map((project) => [
    project.id,
    (receiptOpening.get(project.id) ?? 0) + (projectMovement.get(project.id) ?? 0),
  ]));
  const loans = Object.fromEntries(loansCatalog.map((loan) => {
    let moved = 0;
    for (const effect of loanEffects) {
      if (effect.from_business === loan.from_business && effect.to_business === loan.to_business) moved += Number(effect.delta);
      else if (effect.from_business === loan.to_business && effect.to_business === loan.from_business) moved -= Number(effect.delta);
    }
    return [loan.id, Number(loan.opening) + moved];
  }));

  const businesses: Record<string, number> = {};
  for (const account of accountsCatalog) {
    if (!account.business_id) continue;
    businesses[account.business_id] = (businesses[account.business_id] ?? 0) + (accounts[account.id] ?? 0);
  }

  return {
    totalCash: Object.values(accounts).reduce((sum, amount) => sum + amount, 0),
    accounts,
    businesses,
    people,
    loans,
    projects,
  };
}

router.get('/overview', wrap(async (req, res, next) => {
  if (req.user?.role !== 'owner') return next();

  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  if (params.has('on')) return next();
  const rawToday = params.get('today');
  const today = validDate(rawToday) ?? new Date().toISOString().slice(0, 10);
  if (rawToday !== null && !validDate(rawToday)) {
    return res.status(400).json({ error: 'Use a valid YYYY-MM-DD local date.' });
  }

  const [
    businessRows,
    accountRows,
    projectRows,
    peopleRows,
    loanRows,
    effectRows,
    receiptOpeningRows,
    entryRows,
    receipts,
    reminders,
  ] = await Promise.all([
    query<DbRow>('SELECT id, name FROM businesses ORDER BY created_at'),
    query<DbRow>('SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    query<DbRow>('SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    query<DbRow>('SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    query<DbRow>('SELECT id, from_business, to_business, opening FROM loans'),
    getCurrentBalanceEffects(),
    query<{ project_id: string; amount: number }>(
      `SELECT project_id, COALESCE(SUM(amount), 0)::double precision AS amount
         FROM project_receipts
        WHERE voided_at IS NULL AND entry_id IS NULL
        GROUP BY project_id`,
    ),
    query<DbRow>(
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
       ORDER BY e.occurred_on, e.created_at, e.id`,
      [today],
    ),
    query<DbRow>(
      `SELECT id, project_id, occurred_on, amount, in_cash, entry_id
         FROM project_receipts
        WHERE voided_at IS NULL
          AND (in_cash = false OR entry_id IS NULL)
        ORDER BY occurred_on, id`,
    ),
    query<DbRow>(
      'SELECT id, what, amount, account_id, note, settled FROM reminders WHERE settled = false ORDER BY created_at',
    ),
  ]);

  const effectMap = await effectsForEntries(entryRows.map((entry) => entry.id));
  const entries = entryRows.map((entry) => entryFromRow(entry, effectMap.get(entry.id) ?? []));
  const balances = buildBalances(
    effectRows,
    receiptOpeningRows,
    accountRows,
    projectRows,
    peopleRows,
    loanRows,
  );

  res.json({
    businesses: businessRows,
    accounts: accountRows.map((account) => ({
      id: account.id, name: account.name, businessId: account.business_id, opening: Number(account.opening),
    })),
    projects: projectRows.map((project) => ({
      id: project.id, name: project.name, scope: project.scope, businessId: project.business_id,
    })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id, projectId: receipt.project_id, occurredOn: iso(receipt.occurred_on),
      amount: Number(receipt.amount), inCash: receipt.in_cash, entryId: receipt.entry_id,
    })),
    people: peopleRows.map((person) => ({
      id: person.id, name: person.name, role: person.role, businessId: person.business_id,
      kind: person.kind, opening: Number(person.opening), salary: Number(person.salary),
    })),
    loans: loanRows.map((loan) => ({
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

export const currentOverviewRouter = router;
