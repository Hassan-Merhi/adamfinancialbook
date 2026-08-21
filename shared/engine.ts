/**
 * The engine: what an entry does, and what everything is worth on a given day.
 *
 * Nothing here touches a database or a screen. Give it a catalog and a list of
 * entries and it will tell you every balance, for today or for any past date.
 */

import type {
  Account, Book, Catalog, Effect, Entry, EntryInput, Loan, Person, ProjectReceipt,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Effects: one event, seen from every angle it touches
 * ------------------------------------------------------------------ */

export function computeEffects(input: EntryInput): Effect[] {
  const e: Effect[] = [];
  const amount = round(input.amount);
  if (amount <= 0) return e;

  if (input.kind === 'transfer') {
    if (!input.accountId || !input.toAccountId) return e;
    e.push({ type: 'account', targetId: input.accountId, delta: -amount });
    e.push({ type: 'account', targetId: input.toAccountId, delta: amount });
    return e; // the loan effect needs the catalog; see withLoanEffects
  }

  if (input.kind === 'receipt') {
    if (input.linkReceiptId) {
      // Money already counted as a receipt is only now arriving. It moves cash
      // and marks that receipt banked — it is never counted as revenue twice.
      e.push({ type: 'receipt_banked', targetId: input.linkReceiptId, delta: amount });
    } else if (input.projectId) {
      e.push({ type: 'project', targetId: input.projectId, delta: amount });
    }
    if (!input.historical && input.accountId) {
      e.push({ type: 'account', targetId: input.accountId, delta: amount });
    }
    return e;
  }

  if (input.kind === 'credit_purchase') {
    // Nothing paid: no account is touched, only what you owe grows.
    if (input.personId) e.push({ type: 'person', targetId: input.personId, delta: amount });
    if (input.projectId) e.push({ type: 'cost', targetId: input.projectId, delta: amount });
    return e;
  }

  // Everything else moves cash out of one account.
  if (!input.historical && input.accountId) {
    e.push({ type: 'account', targetId: input.accountId, delta: -amount });
  }
  if (input.kind === 'person_loan' && input.personId) {
    e.push({ type: 'person', targetId: input.personId, delta: amount });   // they owe you more
  }
  if (input.kind === 'salary' && input.personId) {
    e.push({ type: 'person', targetId: input.personId, delta: amount });   // taken against salary
  }
  if (input.kind === 'supplier_payment' && input.personId) {
    e.push({ type: 'person', targetId: input.personId, delta: -amount });  // you owe less
  }
  if (input.projectId) e.push({ type: 'cost', targetId: input.projectId, delta: amount });
  return e;
}

/**
 * Adds the loan effect, which needs to know which business each account
 * belongs to.
 *
 * The rule, once and for all: money leaving A for B always REDUCES "A owes B".
 * The direction is computed, never typed, which is what stops it being logged
 * backwards.
 */
export function withLoanEffects(input: EntryInput, catalog: Catalog): Effect[] {
  const effects = computeEffects(input);
  if (input.amount <= 0) return effects;
  const amount = round(input.amount);

  if (input.kind === 'transfer' && input.accountId && input.toAccountId) {
    const from = businessOfAccount(catalog, input.accountId);
    const to = businessOfAccount(catalog, input.toAccountId);
    if (from && to && from !== to) {
      effects.push({ type: 'loan', fromBusiness: from, toBusiness: to, delta: -amount });
    }
    return effects;
  }

  const payer = input.accountId ? businessOfAccount(catalog, input.accountId) : null;
  if (input.forBusiness && payer && input.forBusiness !== payer && !input.historical) {
    effects.push({ type: 'loan', fromBusiness: payer, toBusiness: input.forBusiness, delta: -amount });
  }
  return effects;
}

function businessOfAccount(catalog: Catalog, accountId: string) {
  return catalog.accounts.find((a) => a.id === accountId)?.businessId ?? null;
}

/* ------------------------------------------------------------------ *
 * Balances: opening figure + every effect up to a date
 * ------------------------------------------------------------------ */

/** Entries in the order they happened; ties broken by when they were written. */
export function ordered(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.occurredOn < b.occurredOn ? -1
    : a.occurredOn > b.occurredOn ? 1
    : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
}

function upTo(entries: Entry[], date?: string): Entry[] {
  return date ? entries.filter((t) => t.occurredOn <= date) : entries;
}

function sumEffects(entries: Entry[], date: string | undefined, pick: (e: Effect) => number): number {
  let total = 0;
  for (const entry of upTo(entries, date)) for (const eff of entry.effects) total += pick(eff);
  return round(total);
}

export function accountBalance(book: Book, accountId: string, date?: string): number {
  const account = book.accounts.find((a) => a.id === accountId);
  if (!account) return 0;
  return round(account.opening + sumEffects(book.entries, date,
    (e) => (e.type === 'account' && e.targetId === accountId ? e.delta : 0)));
}

export function businessCash(book: Book, businessId: string, date?: string): number {
  return round(book.accounts
    .filter((a) => a.businessId === businessId)
    .reduce((s, a) => s + accountBalance(book, a.id, date), 0));
}

export function totalCash(book: Book, date?: string): number {
  return round(book.accounts.reduce((s, a) => s + accountBalance(book, a.id, date), 0));
}

/**
 * A person's balance from YOUR side, which is the only reading that never
 * confuses anyone: minus means you owe them, plus means it is owed to you.
 */
export function personBalance(book: Book, personId: string, date?: string): number {
  const person = book.people.find((p) => p.id === personId);
  if (!person) return 0;
  const moved = sumEffects(book.entries, date,
    (e) => (e.type === 'person' && e.targetId === personId ? e.delta : 0));

  if (person.kind === 'receivable') return round(person.opening + moved);
  if (person.kind === 'payable') return round(-(person.opening + moved));
  // payroll: salary is owed, whatever has been taken counts against it
  return round(person.opening + moved - person.salary);
}

/** Signed as "fromBusiness owes toBusiness"; negative means the other way. */
export function loanBalance(book: Book, loan: Loan, date?: string): number {
  return round(loan.opening + sumEffects(book.entries, date, (e) => {
    if (e.type !== 'loan') return 0;
    if (e.fromBusiness === loan.fromBusiness && e.toBusiness === loan.toBusiness) return e.delta;
    if (e.fromBusiness === loan.toBusiness && e.toBusiness === loan.fromBusiness) return -e.delta;
    return 0;
  }));
}

/** The same position read from one business's side: minus means it owes. */
export function loanFrom(book: Book, loan: Loan, businessId: string, date?: string): number {
  const v = loanBalance(book, loan, date);
  return businessId === loan.fromBusiness ? -v : v;
}

export function projectReceived(book: Book, projectId: string, date?: string): number {
  const opening = book.receipts
    .filter((r) => r.projectId === projectId && !r.entryId && (!date || !r.occurredOn || r.occurredOn <= date))
    .reduce((s, r) => s + r.amount, 0);
  return round(opening + sumEffects(book.entries, date,
    (e) => (e.type === 'project' && e.targetId === projectId ? e.delta : 0)));
}

export function projectSpent(book: Book, projectId: string, date?: string): number {
  return sumEffects(book.entries, date,
    (e) => (e.type === 'cost' && e.targetId === projectId ? e.delta : 0));
}

/** Receipts recorded but not yet arrived in any account. */
export function receiptsNotInCash(book: Book, projectId: string): ProjectReceipt[] {
  const banked = new Set(
    book.entries.flatMap((t) => t.effects)
      .filter((e) => e.type === 'receipt_banked')
      .map((e) => e.targetId));
  return book.receipts.filter((r) => r.projectId === projectId && !r.inCash && !banked.has(r.id));
}

/**
 * The check that stops the same money being counted twice: a receipt of the
 * same size on this project that has not reached an account yet.
 */
export function possibleDuplicateReceipt(book: Book, projectId: string, amount: number): ProjectReceipt | null {
  const open = receiptsNotInCash(book, projectId).find((r) => nearly(r.amount, amount));
  if (open) return open;
  return book.receipts.find((r) => r.projectId === projectId && nearly(r.amount, amount)) ?? null;
}

/* ------------------------------------------------------------------ *
 * Statements
 * ------------------------------------------------------------------ */

export type Target =
  | { type: 'account'; id: string }
  | { type: 'person'; id: string }
  | { type: 'project'; id: string }
  | { type: 'loan'; fromBusiness: string; toBusiness: string; view?: string };

/** How much one entry moved one target, in that target's own reading. */
export function deltaFor(entry: Entry, target: Target, person?: Person): number {
  let v = 0;
  for (const e of entry.effects) {
    if (target.type === 'account' && e.type === 'account' && e.targetId === target.id) v += e.delta;
    if (target.type === 'person' && e.type === 'person' && e.targetId === target.id) {
      v += person && person.kind === 'payable' ? -e.delta : e.delta;
    }
    if (target.type === 'project' && e.type === 'project' && e.targetId === target.id) v += e.delta;
    if (target.type === 'project' && e.type === 'cost' && e.targetId === target.id) v -= e.delta;
    if (target.type === 'loan' && e.type === 'loan') {
      const sign = target.view && target.view === target.fromBusiness ? -1 : 1;
      if (e.fromBusiness === target.fromBusiness && e.toBusiness === target.toBusiness) v += e.delta * sign;
      else if (e.fromBusiness === target.toBusiness && e.toBusiness === target.fromBusiness) v -= e.delta * sign;
    }
  }
  return round(v);
}

export interface StatementRow { entry: Entry; delta: number; running: number; }

/** Every entry that touched a target, oldest first, with a running balance. */
export function statement(book: Book, target: Target): StatementRow[] {
  const person = target.type === 'person' ? book.people.find((p) => p.id === target.id) : undefined;
  let running = openingOf(book, target);
  const rows: StatementRow[] = [];
  for (const entry of ordered(book.entries)) {
    const delta = deltaFor(entry, target, person);
    if (delta === 0 && !touches(entry, target)) continue;
    running = round(running + delta);
    rows.push({ entry, delta, running });
  }
  return rows;
}

function touches(entry: Entry, target: Target): boolean {
  return entry.effects.some((e) => {
    if (target.type === 'account') return e.type === 'account' && e.targetId === target.id;
    if (target.type === 'person') return e.type === 'person' && e.targetId === target.id;
    if (target.type === 'project') return (e.type === 'project' || e.type === 'cost' || e.type === 'receipt_banked') && e.targetId === target.id;
    if (target.type === 'loan') {
      return e.type === 'loan' &&
        ((e.fromBusiness === target.fromBusiness && e.toBusiness === target.toBusiness) ||
         (e.fromBusiness === target.toBusiness && e.toBusiness === target.fromBusiness));
    }
    return false;
  });
}

function openingOf(book: Book, target: Target): number {
  if (target.type === 'account') return book.accounts.find((a) => a.id === target.id)?.opening ?? 0;
  if (target.type === 'person') {
    const p = book.people.find((x) => x.id === target.id);
    if (!p) return 0;
    if (p.kind === 'receivable') return p.opening;
    if (p.kind === 'payable') return -p.opening;
    return p.opening - p.salary;
  }
  if (target.type === 'project') {
    return book.receipts
      .filter((r) => r.projectId === target.id && !r.entryId)
      .reduce((s, r) => s + r.amount, 0);
  }
  const loan = book.loans.find((l) =>
    (l.fromBusiness === target.fromBusiness && l.toBusiness === target.toBusiness) ||
    (l.fromBusiness === target.toBusiness && l.toBusiness === target.fromBusiness));
  if (!loan) return 0;
  const opening = loan.fromBusiness === target.fromBusiness ? loan.opening : -loan.opening;
  return target.view && target.view === target.fromBusiness ? -opening : opening;
}

/* ------------------------------------------------------------------ *
 * Corrections
 * ------------------------------------------------------------------ */

/**
 * A correction replaces the entry rather than leaving two versions floating
 * around: the old effects go, new ones are computed, and the original amount
 * stays on the record.
 */
export function correctEntry(entry: Entry, amount: number, catalog: Catalog): Entry {
  const next: Entry = { ...entry, amount: round(amount) };
  next.effects = withLoanEffects(next, catalog);
  next.correctedFrom = entry.correctedFrom ?? entry.amount;
  return next;
}

/* ------------------------------------------------------------------ */

export function round(n: number): number { return Math.round(n * 100) / 100; }
function nearly(a: number, b: number): boolean { return Math.abs(a - b) < 0.005; }

/* ------------------------------------------------------------------ *
 * Describing an entry before it is saved
 * ------------------------------------------------------------------ */

export interface EffectLine {
  label: string;
  /** How much this target moves. Null for a line that is only a note. */
  delta: number | null;
  /** Where it lands. Null when there is no running figure to show. */
  after: number | null;
  /** True when minus means "you owe it" — people and loan positions. */
  signed: boolean;
}

/**
 * The same event, told from every angle it touches, with the figure each one
 * lands on. This is what the confirmation card shows before anything is saved.
 */
export function describeEffects(effects: Effect[], book: Book): EffectLine[] {
  return effects.map((e): EffectLine => {
    if (e.type === 'account') {
      const account = book.accounts.find((a) => a.id === e.targetId);
      return {
        label: account?.name ?? 'Account',
        delta: e.delta,
        after: round(accountBalance(book, e.targetId!) + e.delta),
        signed: false,
      };
    }
    if (e.type === 'project') {
      const project = book.projects.find((p) => p.id === e.targetId);
      return {
        label: `${project?.name ?? 'Project'} — receipts`,
        delta: e.delta,
        after: round(projectReceived(book, e.targetId!) + e.delta),
        signed: false,
      };
    }
    if (e.type === 'cost') {
      const project = book.projects.find((p) => p.id === e.targetId);
      return { label: `${project?.name ?? 'Project'} — spent on the job`, delta: e.delta, after: null, signed: false };
    }
    if (e.type === 'receipt_banked') {
      const receipt = book.receipts.find((r) => r.id === e.targetId);
      const project = book.projects.find((p) => p.id === receipt?.projectId);
      return {
        label: `${project?.name ?? 'Project'} — the ${receipt?.occurredOn || 'earlier'} receipt reaching cash, not new money`,
        delta: null, after: null, signed: false,
      };
    }
    if (e.type === 'person') {
      const person = book.people.find((p) => p.id === e.targetId);
      const delta = person?.kind === 'payable' ? -e.delta : e.delta;
      const what = person?.kind === 'receivable' ? 'they owe you'
        : person?.kind === 'payable' ? 'you owe them' : 'salary owed';
      return {
        label: `${person?.name ?? 'Person'} — ${what}`,
        delta,
        after: round(personBalance(book, e.targetId!) + delta),
        signed: true,
      };
    }
    // loan
    const loan = book.loans.find((l) =>
      (l.fromBusiness === e.fromBusiness && l.toBusiness === e.toBusiness) ||
      (l.fromBusiness === e.toBusiness && l.toBusiness === e.fromBusiness));
    const current = loan ? (loan.fromBusiness === e.fromBusiness ? loanBalance(book, loan) : -loanBalance(book, loan)) : 0;
    const after = round(current + e.delta);
    const from = book.businesses.find((b) => b.id === e.fromBusiness)?.name ?? '?';
    const to = book.businesses.find((b) => b.id === e.toBusiness)?.name ?? '?';
    return {
      label: after >= 0 ? `${from} owes ${to}` : `${to} owes ${from}`,
      delta: e.delta,
      after: Math.abs(after),
      signed: false,
    };
  });
}
