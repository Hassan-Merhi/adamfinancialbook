import { Router } from 'express';
import { z } from 'zod';
import { newId, pool, query } from './db.js';
import { record, recordRequired } from './audit.js';
import { ensureLoanPair, writeEffects } from './book.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Catalog, Effect, Entry, EntryInput } from '../shared/types.js';

type DbRow = Record<string, any>;

const entryInput = z.object({
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
  clientRef: z.string().max(80).nullish(),
});

function iso(d: Date | string | null): string {
  if (!d) return '';
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

function isoTime(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function effectFromRow(e: DbRow): Effect {
  return {
    type: e.type,
    targetId: e.target_id ?? undefined,
    fromBusiness: e.from_business ?? undefined,
    toBusiness: e.to_business ?? undefined,
    delta: Number(e.delta),
  };
}

function entryFromRow(t: DbRow, effects: Effect[]): Entry {
  return {
    id: t.id,
    occurredOn: iso(t.occurred_on),
    kind: t.kind,
    amount: Number(t.amount),
    purpose: t.purpose,
    raw: t.raw,
    accountId: t.account_id,
    toAccountId: t.to_account_id,
    projectId: t.project_id,
    personId: t.person_id,
    forBusiness: t.for_business,
    historical: t.historical,
    linkReceiptId: t.link_receipt_id,
    clientRef: t.client_ref,
    voided: t.voided ?? false,
    voidReason: t.void_reason ?? null,
    voidedAt: isoTime(t.voided_at),
    voidedBy: t.voided_by ?? null,
    createdBy: t.created_by ?? null,
    effects,
    correctedFrom: t.corrected_from == null ? null : Number(t.corrected_from),
    correctedAt: isoTime(t.corrected_at),
    correctedBy: t.corrected_by ?? null,
    correctionReason: t.correction_reason ?? '',
    transactionId: t.transaction_id,
    createdAt: new Date(t.created_at).toISOString(),
  };
}

/** The posting engine only needs account/business ownership, not ledger history. */
export async function loadPostingCatalog(): Promise<Catalog> {
  const [businesses, accounts, projects, receipts, people, loans] = await Promise.all([
    query<DbRow>('SELECT id, name FROM businesses ORDER BY created_at'),
    query<DbRow>('SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    query<DbRow>('SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    query<DbRow>('SELECT id, project_id, occurred_on, amount, in_cash, entry_id FROM project_receipts WHERE voided_at IS NULL'),
    query<DbRow>('SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    query<DbRow>('SELECT id, from_business, to_business, opening FROM loans'),
  ]);
  return {
    businesses: businesses.map((b) => ({ id: String(b.id), name: String(b.name) })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, businessId: a.business_id, opening: Number(a.opening) })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, scope: p.scope, businessId: p.business_id })),
    receipts: receipts.map((r) => ({
      id: r.id, projectId: r.project_id, occurredOn: iso(r.occurred_on),
      amount: Number(r.amount), inCash: r.in_cash, entryId: r.entry_id,
    })),
    people: people.map((p) => ({
      id: p.id, name: p.name, role: p.role, businessId: p.business_id,
      kind: p.kind, opening: Number(p.opening), salary: Number(p.salary),
    })),
    loans: loans.map((l) => ({ id: l.id, fromBusiness: l.from_business, toBusiness: l.to_business, opening: Number(l.opening) })),
  };
}

async function findByClientRef(clientRef: string): Promise<Entry | null> {
  const entries = await query<DbRow>('SELECT * FROM entries WHERE client_ref = $1 LIMIT 1', [clientRef]);
  const row = entries[0];
  if (!row) return null;
  const effects = await query<DbRow>(
    `SELECT type, target_id, from_business, to_business, delta
       FROM effects WHERE entry_id = $1 AND active = true ORDER BY id`,
    [row.id],
  );
  return entryFromRow(row, effects.map(effectFromRow));
}

export async function savePostedEntry(
  input: EntryInput,
  catalog: Catalog,
  createdBy?: string | null,
): Promise<Entry> {
  if (input.clientRef) {
    const seen = await findByClientRef(input.clientRef);
    if (seen) return seen;
  }

  const id = newId('ent');
  const transactionId = newId('txn');
  const effects = withLoanEffects(input, catalog);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO entries (id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
                            project_id, person_id, for_business, historical, link_receipt_id, client_ref,
                            created_by, transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, input.occurredOn, input.kind, input.amount, input.purpose, input.raw,
       input.accountId ?? null, input.toAccountId ?? null, input.projectId ?? null,
       input.personId ?? null, input.forBusiness ?? null, input.historical ?? false,
       input.linkReceiptId ?? null, input.clientRef ?? null, createdBy ?? null, transactionId],
    );
    await writeEffects(client, id, effects);

    if (input.kind === 'receipt') {
      if (input.linkReceiptId) {
        await client.query(
          'UPDATE project_receipts SET in_cash = true WHERE id = $1 AND voided_at IS NULL',
          [input.linkReceiptId],
        );
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
        createdBy: createdBy ?? null,
      },
      transactionId,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505' && input.clientRef) {
      const seen = await findByClientRef(input.clientRef);
      if (seen) return seen;
    }
    throw error;
  } finally {
    client.release();
  }

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
    createdBy: createdBy ?? null,
    createdAt: new Date().toISOString(),
  };
}

export const postingRouter = Router();

postingRouter.post('/entries', async (req, res, next) => {
  try {
    const input = entryInput.parse(req.body);
    const catalog = await loadPostingCatalog();
    if (input.kind === 'credit_purchase' && !input.personId) {
      return res.status(400).json({ error: 'A purchase on credit needs someone to owe.' });
    }
    if (input.kind === 'transfer' && (!input.accountId || !input.toAccountId)) {
      return res.status(400).json({ error: 'A transfer needs both accounts.' });
    }
    if (input.kind !== 'credit_purchase' && input.kind !== 'receipt' && !input.accountId && !input.historical) {
      return res.status(400).json({ error: 'Say which account the money came out of.' });
    }
    if (input.forBusiness && input.accountId) {
      const payer = catalog.accounts.find((a) => a.id === input.accountId)?.businessId;
      if (payer && payer !== input.forBusiness) await ensureLoanPair(payer, input.forBusiness);
    }
    if (input.kind === 'transfer') {
      const from = catalog.accounts.find((a) => a.id === input.accountId)?.businessId;
      const to = catalog.accounts.find((a) => a.id === input.toAccountId)?.businessId;
      if (from && to && from !== to) await ensureLoanPair(from, to);
    }

    const entry = await savePostedEntry(input, catalog, req.user?.id);
    await record(req, 'entry logged', entry.id, {
      amount: entry.amount,
      kind: entry.kind,
      purpose: entry.purpose,
      on: entry.occurredOn,
    });
    return res.status(201).json(entry);
  } catch (error) {
    return next(error);
  }
});
