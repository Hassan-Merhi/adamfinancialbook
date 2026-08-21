/** Reading the whole book out of the database, and writing entries back in. */
import type { PoolClient } from 'pg';
import { newId, pool, query } from './db.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Book, Effect, Entry, EntryInput } from '../shared/types.js';

export async function loadBook(): Promise<Book> {
  const [businesses, accounts, projects, receipts, people, loans, entries, effects] = await Promise.all([
    query('SELECT id, name FROM businesses ORDER BY created_at'),
    query('SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    query('SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    query('SELECT id, project_id, occurred_on, amount, in_cash, entry_id FROM project_receipts'),
    query('SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    query('SELECT id, from_business, to_business, opening FROM loans'),
    query('SELECT * FROM entries ORDER BY occurred_on, created_at'),
    query('SELECT * FROM effects ORDER BY id'),
  ]);

  const byEntry = new Map<string, Effect[]>();
  for (const e of effects) {
    const list = byEntry.get(e.entry_id) ?? [];
    list.push({
      type: e.type,
      targetId: e.target_id ?? undefined,
      fromBusiness: e.from_business ?? undefined,
      toBusiness: e.to_business ?? undefined,
      delta: e.delta,
    });
    byEntry.set(e.entry_id, list);
  }

  return {
    businesses,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, businessId: a.business_id, opening: a.opening })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, scope: p.scope, businessId: p.business_id })),
    receipts: receipts.map((r) => ({
      id: r.id, projectId: r.project_id, occurredOn: iso(r.occurred_on),
      amount: r.amount, inCash: r.in_cash, entryId: r.entry_id,
    })),
    people: people.map((p) => ({
      id: p.id, name: p.name, role: p.role, businessId: p.business_id,
      kind: p.kind, opening: p.opening, salary: p.salary,
    })),
    loans: loans.map((l) => ({ id: l.id, fromBusiness: l.from_business, toBusiness: l.to_business, opening: l.opening })),
    entries: entries.map((t) => ({
      id: t.id, occurredOn: iso(t.occurred_on), kind: t.kind, amount: t.amount,
      purpose: t.purpose, raw: t.raw, accountId: t.account_id, toAccountId: t.to_account_id,
      projectId: t.project_id, personId: t.person_id, forBusiness: t.for_business,
      historical: t.historical, linkReceiptId: t.link_receipt_id,
      effects: byEntry.get(t.id) ?? [], correctedFrom: t.corrected_from,
      createdAt: new Date(t.created_at).toISOString(),
    })),
  };
}

function iso(d: Date | string | null): string {
  if (!d) return '';
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * Writes one entry with its effects in a single transaction. A receipt that is
 * new to the book also writes the receipt row; one that was already recorded
 * and is only now arriving marks that row as reaching cash instead.
 */
export async function saveEntry(input: EntryInput, book: Book): Promise<Entry> {
  const id = newId('ent');
  const effects = withLoanEffects(input, book);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO entries (id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
                            project_id, person_id, for_business, historical, link_receipt_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, input.occurredOn, input.kind, input.amount, input.purpose, input.raw,
       input.accountId ?? null, input.toAccountId ?? null, input.projectId ?? null,
       input.personId ?? null, input.forBusiness ?? null, input.historical ?? false,
       input.linkReceiptId ?? null]);

    await writeEffects(client, id, effects);

    if (input.kind === 'receipt') {
      if (input.linkReceiptId) {
        await client.query('UPDATE project_receipts SET in_cash = true WHERE id = $1', [input.linkReceiptId]);
      } else if (input.projectId) {
        await client.query(
          `INSERT INTO project_receipts (id, project_id, occurred_on, amount, in_cash, entry_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [newId('rcp'), input.projectId, input.occurredOn, input.amount, !input.historical, id]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { id, ...input, effects, correctedFrom: null, createdAt: new Date().toISOString() };
}

/**
 * A correction replaces the entry: the old effects are removed, new ones are
 * computed, and the original amount is kept so the change stays on the record.
 */
export async function correctAmount(entryId: string, amount: number, book: Book): Promise<void> {
  const entry = book.entries.find((e) => e.id === entryId);
  if (!entry) throw Object.assign(new Error('No such entry'), { status: 404 });

  const effects = withLoanEffects({ ...entry, amount }, book);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE entries SET amount = $2, corrected_from = COALESCE(corrected_from, $3) WHERE id = $1`,
      [entryId, amount, entry.amount]);
    await client.query('DELETE FROM effects WHERE entry_id = $1', [entryId]);
    await writeEffects(client, entryId, effects);
    if (entry.kind === 'receipt' && !entry.linkReceiptId) {
      await client.query('UPDATE project_receipts SET amount = $2 WHERE entry_id = $1', [entryId, amount]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function writeEffects(client: PoolClient, entryId: string, effects: Effect[]) {
  for (const eff of effects) {
    await client.query(
      `INSERT INTO effects (entry_id, type, target_id, from_business, to_business, delta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entryId, eff.type, eff.targetId ?? null, eff.fromBusiness ?? null, eff.toBusiness ?? null, eff.delta]);
  }
}

/** Positions between businesses appear the first time money crosses. */
export async function ensureLoanPair(from: string, to: string): Promise<void> {
  const existing = await query(
    `SELECT id FROM loans WHERE (from_business = $1 AND to_business = $2)
                              OR (from_business = $2 AND to_business = $1)`, [from, to]);
  if (existing.length === 0) {
    await query('INSERT INTO loans (id, from_business, to_business, opening) VALUES ($1,$2,$3,0)',
      [newId('loan'), from, to]);
  }
}
