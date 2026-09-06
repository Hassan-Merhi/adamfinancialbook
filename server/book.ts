/** Reading the whole book out of the database, and writing entries back in. */
import type { PoolClient } from 'pg';
import { newId, pool, query } from './db.js';
import { recordRequired } from './audit.js';
import { currentRequestActor } from './request-context.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Book, Effect, Entry, EntryInput } from '../shared/types.js';

type DbRow = Record<string, any>;

export interface EntryStateSnapshot {
  entry: DbRow;
  effects: DbRow[];
}

export async function loadBook(): Promise<Book> {
  const [businesses, accounts, projects, receipts, people, loans, entries, effects, reminders] = await Promise.all([
    query('SELECT id, name FROM businesses ORDER BY created_at'),
    query('SELECT id, name, business_id, opening FROM accounts ORDER BY created_at'),
    query('SELECT id, name, scope, business_id FROM projects ORDER BY created_at'),
    query('SELECT id, project_id, occurred_on, amount, in_cash, entry_id FROM project_receipts WHERE voided_at IS NULL'),
    query('SELECT id, name, role, business_id, kind, opening, salary FROM people ORDER BY created_at'),
    query('SELECT id, from_business, to_business, opening FROM loans'),
    query('SELECT * FROM entries ORDER BY occurred_on, created_at'),
    query('SELECT * FROM effects WHERE active = true ORDER BY id'),
    query('SELECT id, what, amount, account_id, note, settled FROM reminders WHERE settled = false ORDER BY created_at'),
  ]);

  const byEntry = new Map<string, Effect[]>();
  for (const e of effects) {
    const list = byEntry.get(e.entry_id) ?? [];
    list.push(effectFromRow(e));
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
    reminders: reminders.map((r) => ({
      id: r.id, what: r.what, amount: r.amount, accountId: r.account_id, note: r.note, settled: r.settled,
    })),
    entries: entries.map(entryFromRow).map((entry) => ({ ...entry, effects: byEntry.get(entry.id) ?? [] })),
  };
}

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

function entryFromRow(t: DbRow): Entry {
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
    effects: [],
    correctedFrom: t.corrected_from == null ? null : Number(t.corrected_from),
    correctedAt: isoTime(t.corrected_at),
    correctedBy: t.corrected_by ?? null,
    correctionReason: t.correction_reason ?? '',
    transactionId: t.transaction_id,
    createdAt: new Date(t.created_at).toISOString(),
  };
}

function inputFromRow(row: DbRow): EntryInput {
  return {
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
  };
}

/**
 * Writes one entry with its effects, receipt bookkeeping, transaction id, and
 * required audit line in one transaction.
 */
export async function saveEntry(input: EntryInput, book: Book, createdBy?: string | null): Promise<Entry> {
  // Sent twice? Hand back the one already in the book rather than logging it again.
  if (input.clientRef) {
    const seen = book.entries.find((e) => e.clientRef === input.clientRef);
    if (seen) return seen;
  }

  const id = newId('ent');
  const transactionId = newId('txn');
  const effects = withLoanEffects(input, book);
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
       input.linkReceiptId ?? null, input.clientRef ?? null, createdBy ?? null, transactionId]);

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
          [newId('rcp'), input.projectId, input.occurredOn, input.amount, !input.historical, id]);
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
  } catch (err) {
    await client.query('ROLLBACK');
    // The same entry arriving twice at once: the unique reference stopped it.
    if ((err as { code?: string }).code === '23505' && input.clientRef) {
      const fresh = await loadBook();
      const seen = fresh.entries.find((e) => e.clientRef === input.clientRef);
      if (seen) return seen;
    }
    throw err;
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

/**
 * A correction keeps the original entry/effect state in entry_revisions and
 * supersedes the old effect rows instead of deleting them. A posted correction
 * is final: if it is still wrong, the safe next action is to void the entry.
 */
export async function correctAmount(entryId: string, amount: number, book: Book): Promise<void> {
  const transactionId = newId('txn');
  const actor = currentRequestActor();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await captureEntryState(client, entryId, true);
    if (!before || before.entry.voided) {
      throw Object.assign(new Error('No such active entry'), { status: 404 });
    }
    if (before.entry.corrected_at || before.entry.corrected_from != null) {
      throw Object.assign(
        new Error('This entry was already corrected and is now locked. Void it if it is still wrong.'),
        { status: 409 },
      );
    }

    const oldAmount = Number(before.entry.amount);
    const reason = `Amount corrected from ${oldAmount.toFixed(2)} to ${Number(amount).toFixed(2)}`;
    const nextInput = { ...inputFromRow(before.entry), amount };
    const effects = withLoanEffects(nextInput, book);

    await client.query(
      `UPDATE entries
          SET amount = $2,
              corrected_from = COALESCE(corrected_from, $3),
              corrected_at = now(),
              corrected_by = $4,
              correction_reason = $5
        WHERE id = $1`,
      [entryId, amount, oldAmount, actor?.id ?? null, reason],
    );
    await supersedeEffects(client, entryId, actor?.id ?? null);
    await writeEffects(client, entryId, effects);

    if (before.entry.kind === 'receipt' && !before.entry.link_receipt_id) {
      await client.query(
        'UPDATE project_receipts SET amount = $2 WHERE entry_id = $1 AND voided_at IS NULL',
        [entryId, amount],
      );
    }

    const after = await captureEntryState(client, entryId, false);
    if (!after) throw new Error('Corrected entry disappeared inside its transaction.');
    await writeEntryRevision(client, entryId, transactionId, 'correction', reason, before, after);
    await recordRequired(
      client,
      'financial entry corrected',
      entryId,
      { from: oldAmount, to: amount, reason },
      transactionId,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function writeEffects(client: PoolClient, entryId: string, effects: Effect[]): Promise<void> {
  for (const eff of effects) {
    await client.query(
      `INSERT INTO effects (entry_id, type, target_id, from_business, to_business, delta, active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [entryId, eff.type, eff.targetId ?? null, eff.fromBusiness ?? null, eff.toBusiness ?? null, eff.delta]);
  }
}

export async function supersedeEffects(
  client: PoolClient,
  entryId: string,
  actorId: string | null = currentRequestActor()?.id ?? null,
): Promise<void> {
  await client.query(
    `UPDATE effects
        SET active = false,
            superseded_at = COALESCE(superseded_at, now()),
            superseded_by = COALESCE(superseded_by, $2)
      WHERE entry_id = $1 AND active = true`,
    [entryId, actorId],
  );
}

export async function captureEntryState(
  client: PoolClient,
  entryId: string,
  lock: boolean,
): Promise<EntryStateSnapshot | null> {
  const entry = await client.query(
    `SELECT * FROM entries WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [entryId],
  );
  if (!entry.rows[0]) return null;
  const effects = await client.query(
    `SELECT id, entry_id, type, target_id, from_business, to_business, delta, active,
            superseded_at, superseded_by
       FROM effects WHERE entry_id = $1 AND active = true ORDER BY id`,
    [entryId],
  );
  return { entry: entry.rows[0], effects: effects.rows };
}

export async function writeEntryRevision(
  client: PoolClient,
  entryId: string,
  transactionId: string,
  revisionType: 'correction' | 'classification' | 'void',
  reason: string,
  before: EntryStateSnapshot,
  after: EntryStateSnapshot,
): Promise<void> {
  const actor = currentRequestActor();
  await client.query(
    `INSERT INTO entry_revisions
      (entry_id, transaction_id, revision_type, actor_id, actor_email, reason,
       before_entry, before_effects, after_entry, after_effects)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entryId,
      transactionId,
      revisionType,
      actor?.id ?? null,
      actor?.email ?? null,
      reason,
      JSON.stringify(before.entry),
      JSON.stringify(before.effects),
      JSON.stringify(after.entry),
      JSON.stringify(after.effects),
    ],
  );
}

/**
 * A wrong entry is voided, not deleted. The row and revision evidence stay
 * reconstructible, but every active accounting effect is superseded so no
 * balance path can accidentally keep counting it.
 */
export async function voidEntry(entryId: string, reason: string): Promise<void> {
  const transactionId = newId('txn');
  const actor = currentRequestActor();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await captureEntryState(client, entryId, true);
    if (!before || before.entry.voided) {
      throw Object.assign(new Error('No such entry, or it is already void'), { status: 404 });
    }

    const done = await client.query(
      `UPDATE entries
          SET voided = true,
              void_reason = $2,
              voided_at = now(),
              voided_by = $3
        WHERE id = $1 AND voided = false`,
      [entryId, reason, actor?.id ?? null],
    );
    if (done.rowCount === 0) {
      throw Object.assign(new Error('No such entry, or it is already void'), { status: 404 });
    }

    // A void is an accounting reversal, not just a UI flag. Deactivate every
    // effect that currently contributes to cash, projects, people and loans.
    await supersedeEffects(client, entryId, actor?.id ?? null);

    await client.query(
      `UPDATE project_receipts
          SET voided_at = COALESCE(voided_at, now()),
              voided_by = COALESCE(voided_by, $2)
        WHERE entry_id = $1 AND voided_at IS NULL`,
      [entryId, actor?.id ?? null],
    );

    // If this entry merely moved an older recorded receipt into cash, undo that
    // banking state rather than voiding the original historical receipt itself.
    if (before.entry.kind === 'receipt' && before.entry.link_receipt_id) {
      await client.query(
        'UPDATE project_receipts SET in_cash = false WHERE id = $1 AND voided_at IS NULL',
        [before.entry.link_receipt_id],
      );
    }

    // Confirmed delegated handoffs keep their history but no longer claim to be
    // live once their linked ledger transfer has been voided.
    await client.query(
      `UPDATE pending_transfers SET status = 'voided'
        WHERE entry_id = $1 AND status = 'confirmed'`,
      [entryId],
    );

    const after = await captureEntryState(client, entryId, false);
    if (!after) throw new Error('Voided entry disappeared inside its transaction.');
    await writeEntryRevision(client, entryId, transactionId, 'void', reason, before, after);
    await recordRequired(
      client,
      'financial entry voided',
      entryId,
      { reason, amount: Number(before.entry.amount), purpose: before.entry.purpose },
      transactionId,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Positions between businesses appear the first time money crosses. */
export async function ensureLoanPair(from: string, to: string): Promise<void> {
  if (from === to) return;
  const client = await pool.connect();
  const [a, b] = [from, to].sort();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`loan:${a}:${b}`]);
    const existing = await client.query(
      `SELECT id FROM loans WHERE (from_business = $1 AND to_business = $2)
                                OR (from_business = $2 AND to_business = $1)`,
      [from, to],
    );
    if (existing.rowCount === 0) {
      await client.query(
        'INSERT INTO loans (id, from_business, to_business, opening) VALUES ($1,$2,$3,0)',
        [newId('loan'), from, to],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
