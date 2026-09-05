/**
 * The whole book in types.
 *
 * One idea runs through all of it: an entry is a single event, and every
 * consequence of that event is stored with it as an effect. Balances are never
 * written down — they are always an opening figure plus the effects on top.
 * That is what makes a past date reproducible and double-counting impossible.
 */

export type BusinessId = string;
export type Id = string;

export interface Business { id: BusinessId; name: string; }

export interface Account {
  id: Id;
  name: string;
  businessId: BusinessId;
  opening: number;
}

export interface Project {
  id: Id;
  name: string;
  scope: string;
  businessId: BusinessId;
}

/** A receipt from a client, counted once on the day the job pays. */
export interface ProjectReceipt {
  id: Id;
  projectId: Id;
  /** ISO date, or '' when the date is genuinely unknown. */
  occurredOn: string;
  amount: number;
  /** false while the money is promised but has not reached an account. */
  inCash: boolean;
  entryId: Id | null;
}

/**
 * Three kinds of person, never mixed:
 *   receivable — they owe you
 *   payable    — you owe them (a supplier)
 *   salary     — payroll: `salary` is owed each period, advances count against it
 */
export type PersonKind = 'receivable' | 'payable' | 'salary';

export interface Person {
  id: Id;
  name: string;
  role: string;
  businessId: BusinessId;
  kind: PersonKind;
  /** Opening figure in the person's own terms: an amount owed, either way. */
  opening: number;
  /** Payroll only. */
  salary: number;
}

/**
 * A position between two of your own businesses. `amount` is always read as
 * "`fromBusiness` owes `toBusiness`" — a negative value simply means the debt
 * runs the other way. The pair is never flipped in storage, so history stays
 * readable.
 */
export interface Loan {
  id: Id;
  fromBusiness: BusinessId;
  toBusiness: BusinessId;
  opening: number;
}

export type EntryKind =
  | 'expense'          // money left an account
  | 'credit_purchase'  // goods taken, nothing paid: only what you owe changes
  | 'receipt'          // a project paid you
  | 'transfer'         // between two of your own accounts
  | 'person_loan'      // you lent someone money
  | 'salary'           // paid against what an employee is owed
  | 'supplier_payment'; // paid down what you owe a supplier

export interface EntryInput {
  occurredOn: string;         // ISO date
  kind: EntryKind;
  amount: number;
  purpose: string;
  raw: string;                // exactly what was typed
  accountId?: Id | null;
  toAccountId?: Id | null;    // transfers
  projectId?: Id | null;
  personId?: Id | null;
  /** Paid out of one business's account on behalf of another. */
  forBusiness?: BusinessId | null;
  /** History being recorded after the fact: updates the past, not today's cash. */
  historical?: boolean;
  /** This money was already counted as a project receipt; it is only now arriving. */
  linkReceiptId?: Id | null;
  /**
   * A reference the app made before sending. If the same entry is sent twice —
   * two tabs, a retry, an outbox flushed by two events at once — the second one
   * is recognised and ignored rather than logged again.
   */
  clientRef?: string | null;
}

export type EffectType = 'account' | 'project' | 'person' | 'loan' | 'cost' | 'receipt_banked';

/**
 * One consequence of one entry. `delta` is signed in the target's own terms:
 * cash up or down, an amount owed up or down, a loan position moving.
 */
export interface Effect {
  type: EffectType;
  targetId?: Id;
  fromBusiness?: BusinessId;
  toBusiness?: BusinessId;
  delta: number;
}

export interface Entry extends EntryInput {
  id: Id;
  effects: Effect[];
  /** Stable database transaction id for the original posting. */
  transactionId?: string | null;
  /** Set when an entry has been corrected, so the original amount stays visible. */
  correctedFrom: number | null;
  correctedAt?: string | null;
  correctedBy?: string | null;
  correctionReason?: string;
  /** A wrong entry is voided rather than deleted: it stops counting and says why. */
  voided?: boolean;
  voidReason?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  createdAt: string;
  createdBy?: string | null;
}

/** Who did what, and when. Written beside the book and never edited. */
export interface AuditLine {
  id: string;
  at: string;
  actorEmail: string | null;
  action: string;
  subject: string | null;
  detail: Record<string, unknown>;
  transactionId?: string | null;
}

/**
 * Money spoken for but not yet paid. It is a note to himself, never a movement:
 * nothing here appears in any balance.
 */
export interface Reminder {
  id: Id;
  what: string;
  amount: number;
  accountId: Id | null;
  note: string;
  settled: boolean;
}

/** Everything the engine needs to interpret a sentence and compute effects. */
export interface Catalog {
  businesses: Business[];
  accounts: Account[];
  projects: Project[];
  receipts: ProjectReceipt[];
  people: Person[];
  loans: Loan[];
}

export interface Book extends Catalog {
  entries: Entry[];
  reminders: Reminder[];
}
