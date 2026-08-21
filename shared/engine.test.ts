import { describe, expect, it } from 'vitest';
import {
  accountBalance, businessCash, correctEntry, loanBalance, loanFrom,
  personBalance, possibleDuplicateReceipt, projectReceived, statement, withLoanEffects,
} from './engine.js';
import type { Book, EntryInput } from './types.js';

/** A small book: two businesses, an account each, a project, three people. */
function book(): Book {
  return {
    businesses: [{ id: 'con', name: 'Construction' }, { id: 'mot', name: 'Motors' }],
    accounts: [
      { id: 'con_cash', name: 'Construction Cash', businessId: 'con', opening: 10_000 },
      { id: 'mot_cash', name: 'Motors Cash', businessId: 'mot', opening: 2_000 },
    ],
    projects: [{ id: 'kin', name: 'Kin Severe', scope: 'Factory', businessId: 'con' }],
    receipts: [
      { id: 'r1', projectId: 'kin', occurredOn: '2026-06-03', amount: 50_000, inCash: false, entryId: null },
    ],
    people: [
      { id: 'danny', name: 'Danny', role: 'Personal loan', businessId: 'con', kind: 'receivable', opening: 0, salary: 0 },
      { id: 'dani', name: 'Dani Hardware', role: 'Supplier', businessId: 'con', kind: 'payable', opening: 0, salary: 0 },
      { id: 'abo', name: 'Abo Sheker', role: 'Staff', businessId: 'con', kind: 'salary', opening: 0, salary: 400 },
    ],
    loans: [{ id: 'l1', fromBusiness: 'con', toBusiness: 'mot', opening: 7_000 }],
    entries: [],
  };
}

let seq = 0;
function log(b: Book, input: EntryInput) {
  const entry = {
    id: `e${++seq}`,
    ...input,
    effects: withLoanEffects(input, b),
    correctedFrom: null,
    createdAt: `2026-08-12T00:00:${String(seq).padStart(2, '0')}Z`,
  };
  b.entries.push(entry);
  return entry;
}

describe('cash', () => {
  it('an expense leaves one account and nothing else', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-01', kind: 'expense', amount: 900, purpose: 'Chargeuse', raw: '', accountId: 'con_cash' });
    expect(accountBalance(b, 'con_cash')).toBe(9_100);
    expect(accountBalance(b, 'mot_cash')).toBe(2_000);
  });

  it('a transfer between own accounts moves money without spending it', () => {
    const b = book();
    const before = businessCash(b, 'con') + businessCash(b, 'mot');
    log(b, { occurredOn: '2026-08-02', kind: 'transfer', amount: 3_000, purpose: 'Repayment', raw: '', accountId: 'con_cash', toAccountId: 'mot_cash' });
    expect(accountBalance(b, 'con_cash')).toBe(7_000);
    expect(accountBalance(b, 'mot_cash')).toBe(5_000);
    expect(businessCash(b, 'con') + businessCash(b, 'mot')).toBe(before);
  });
});

describe('loan direction — the one that used to go backwards', () => {
  it('paying another business expense from your cash REDUCES what you owe it', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-03', kind: 'expense', amount: 200, purpose: 'Advertising', raw: '', accountId: 'con_cash', forBusiness: 'mot' });
    expect(loanBalance(b, b.loans[0])).toBe(6_800);       // Construction owes Motors less
    expect(accountBalance(b, 'con_cash')).toBe(9_800);
  });

  it('a cross-business transfer pays the position down too', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-04', kind: 'transfer', amount: 3_000, purpose: 'Repayment', raw: '', accountId: 'con_cash', toAccountId: 'mot_cash' });
    expect(loanBalance(b, b.loans[0])).toBe(4_000);
  });

  it('past what is owed, the position simply runs the other way', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-05', kind: 'transfer', amount: 9_000, purpose: 'Overpaid', raw: '', accountId: 'con_cash', toAccountId: 'mot_cash' });
    expect(loanBalance(b, b.loans[0])).toBe(-2_000);
    expect(loanFrom(b, b.loans[0], 'con')).toBe(2_000);   // Construction is owed
    expect(loanFrom(b, b.loans[0], 'mot')).toBe(-2_000);  // Motors owes
  });
});

describe('signs — minus means you owe it', () => {
  it('buying on credit touches no account and puts you in the minus', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-06', kind: 'credit_purchase', amount: 1_000, purpose: 'Steel', raw: '', personId: 'dani' });
    expect(accountBalance(b, 'con_cash')).toBe(10_000);   // nothing paid
    expect(personBalance(b, 'dani')).toBe(-1_000);        // you owe them
  });

  it('paying the supplier moves both, and the balance climbs toward zero', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-06', kind: 'credit_purchase', amount: 1_000, purpose: 'Steel', raw: '', personId: 'dani' });
    log(b, { occurredOn: '2026-08-07', kind: 'supplier_payment', amount: 700, purpose: 'Paid Dani', raw: '', accountId: 'con_cash', personId: 'dani' });
    expect(personBalance(b, 'dani')).toBe(-300);
    expect(accountBalance(b, 'con_cash')).toBe(9_300);
  });

  it('lending someone money puts them in the plus', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-08', kind: 'person_loan', amount: 2_500, purpose: 'Loan', raw: '', accountId: 'con_cash', personId: 'danny' });
    expect(personBalance(b, 'danny')).toBe(2_500);
    expect(accountBalance(b, 'con_cash')).toBe(7_500);
  });

  it('unpaid salary reads as a minus, and clears as it is taken', () => {
    const b = book();
    expect(personBalance(b, 'abo')).toBe(-400);
    log(b, { occurredOn: '2026-08-09', kind: 'salary', amount: 200, purpose: 'Advance', raw: '', accountId: 'con_cash', personId: 'abo' });
    expect(personBalance(b, 'abo')).toBe(-200);
  });
});

describe('receipts — the $50,000 that must not be counted twice', () => {
  it('a fresh receipt counts once and lands in cash', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-10', kind: 'receipt', amount: 20_000, purpose: 'Receipt', raw: '', accountId: 'con_cash', projectId: 'kin' });
    expect(projectReceived(b, 'kin')).toBe(70_000);
    expect(accountBalance(b, 'con_cash')).toBe(30_000);
  });

  it('money already recorded, only now arriving, moves cash and nothing else', () => {
    const b = book();
    const dup = possibleDuplicateReceipt(b, 'kin', 50_000);
    expect(dup?.id).toBe('r1');
    log(b, { occurredOn: '2026-08-10', kind: 'receipt', amount: 50_000, purpose: 'Receipt', raw: '', accountId: 'con_cash', projectId: 'kin', linkReceiptId: 'r1' });
    expect(projectReceived(b, 'kin')).toBe(50_000);       // unchanged
    expect(accountBalance(b, 'con_cash')).toBe(60_000);   // arrived
  });

  it('a historical receipt updates the past and leaves today alone', () => {
    const b = book();
    log(b, { occurredOn: '2026-03-17', kind: 'receipt', amount: 33_000, purpose: 'Old receipt', raw: '', accountId: 'con_cash', projectId: 'kin', historical: true });
    expect(projectReceived(b, 'kin')).toBe(83_000);
    expect(accountBalance(b, 'con_cash')).toBe(10_000);   // cash untouched
  });
});

describe('any past day can be rebuilt', () => {
  it('balances answer for the date asked, not just for today', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-01', kind: 'expense', amount: 1_000, purpose: 'One', raw: '', accountId: 'con_cash' });
    log(b, { occurredOn: '2026-08-05', kind: 'expense', amount: 2_000, purpose: 'Two', raw: '', accountId: 'con_cash' });
    expect(accountBalance(b, 'con_cash', '2026-07-31')).toBe(10_000);
    expect(accountBalance(b, 'con_cash', '2026-08-01')).toBe(9_000);
    expect(accountBalance(b, 'con_cash', '2026-08-04')).toBe(9_000);
    expect(accountBalance(b, 'con_cash')).toBe(7_000);
  });

  it('a statement runs a balance down the page', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-01', kind: 'expense', amount: 1_000, purpose: 'One', raw: '', accountId: 'con_cash' });
    log(b, { occurredOn: '2026-08-05', kind: 'expense', amount: 2_000, purpose: 'Two', raw: '', accountId: 'con_cash' });
    const rows = statement(b, { type: 'account', id: 'con_cash' });
    expect(rows.map((r) => r.running)).toEqual([9_000, 7_000]);
  });
});

describe('corrections', () => {
  it('a correction replaces the entry and keeps the original amount visible', () => {
    const b = book();
    const entry = log(b, { occurredOn: '2026-08-11', kind: 'expense', amount: 1_500, purpose: 'Rent', raw: '', accountId: 'con_cash' });
    expect(accountBalance(b, 'con_cash')).toBe(8_500);

    b.entries[b.entries.length - 1] = correctEntry(entry, 1_000, b);
    expect(accountBalance(b, 'con_cash')).toBe(9_000);
    expect(b.entries[b.entries.length - 1].correctedFrom).toBe(1_500);
  });

  it('correcting twice still remembers the original figure', () => {
    const b = book();
    const entry = log(b, { occurredOn: '2026-08-11', kind: 'expense', amount: 1_500, purpose: 'Rent', raw: '', accountId: 'con_cash' });
    const once = correctEntry(entry, 1_000, b);
    const twice = correctEntry(once, 1_200, b);
    expect(twice.correctedFrom).toBe(1_500);
  });
});
