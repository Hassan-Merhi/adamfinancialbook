import { describe, expect, it } from 'vitest';
import type { LoadedBook } from './api';
import { isProjectedEntry, projectOfflineBook } from './offline-projection';
import type { Queued } from './offline-db';
import type { EntryInput } from '../../shared/types';

function baseBook(): LoadedBook {
  return {
    businesses: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    accounts: [
      { id: 'a_cash', name: 'A Cash', businessId: 'a', opening: 1000 },
      { id: 'b_cash', name: 'B Cash', businessId: 'b', opening: 500 },
    ],
    projects: [{ id: 'p1', name: 'Project', scope: '', businessId: 'a' }],
    receipts: [],
    people: [
      { id: 'supplier', name: 'Supplier', role: '', businessId: 'a', kind: 'payable', opening: 300, salary: 0 },
      { id: 'debtor', name: 'Debtor', role: '', businessId: 'a', kind: 'receivable', opening: 200, salary: 0 },
    ],
    loans: [{ id: 'loan_ab', fromBusiness: 'a', toBusiness: 'b', opening: 100 }],
    entries: [],
    reminders: [],
    balances: {
      totalCash: 1500,
      accounts: { a_cash: 1000, b_cash: 500 },
      businesses: { a: 1000, b: 500 },
      people: { supplier: -300, debtor: 200 },
      loans: { loan_ab: 100 },
      projects: { p1: 1000 },
    },
  };
}

function queued(id: string, input: EntryInput, at = '2026-09-06T00:00:00.000Z'): Queued {
  return { id, input: { ...input, clientRef: id }, queuedAt: at };
}

function input(patch: Partial<EntryInput> = {}): EntryInput {
  return {
    occurredOn: '2026-09-06',
    kind: 'expense',
    amount: 100,
    purpose: 'Offline work',
    raw: 'Offline work',
    accountId: 'a_cash',
    ...patch,
  };
}

describe('Phase 2 projected offline ledger', () => {
  it('adds a synthetic pending ledger row and projects account/business/cash balances', () => {
    const confirmed = baseBook();
    const projected = projectOfflineBook(confirmed, [queued('q1', input())]);

    expect(projected).not.toBe(confirmed);
    expect(projected.entries).toHaveLength(1);
    expect(isProjectedEntry(projected.entries[0])).toBe(true);
    expect(projected.entries[0].id).toBe('offline:q1');
    expect(projected.entries[0].clientRef).toBe('q1');
    expect(projected.balances.accounts.a_cash).toBe(900);
    expect(projected.balances.businesses.a).toBe(900);
    expect(projected.balances.totalCash).toBe(1400);

    // Projection is a view only; the confirmed snapshot remains untouched.
    expect(confirmed.entries).toEqual([]);
    expect(confirmed.balances.accounts.a_cash).toBe(1000);
    expect(confirmed.balances.totalCash).toBe(1500);
  });

  it('projects transfers across both accounts and the canonical intercompany position', () => {
    const projected = projectOfflineBook(baseBook(), [queued('move', input({
      kind: 'transfer', amount: 200, toAccountId: 'b_cash', purpose: 'Move cash',
    }))]);

    expect(projected.balances.accounts.a_cash).toBe(800);
    expect(projected.balances.accounts.b_cash).toBe(700);
    expect(projected.balances.totalCash).toBe(1500);
    expect(projected.balances.businesses.a).toBe(800);
    expect(projected.balances.businesses.b).toBe(700);
    expect(projected.balances.loans.loan_ab).toBe(-100);
  });

  it('uses displayed person-balance signs for payables and receivables', () => {
    const projected = projectOfflineBook(baseBook(), [
      queued('buy', input({ kind: 'credit_purchase', amount: 40, accountId: null, personId: 'supplier' }), '2026-09-06T00:00:01.000Z'),
      queued('pay', input({ kind: 'supplier_payment', amount: 50, personId: 'supplier' }), '2026-09-06T00:00:02.000Z'),
      queued('lend', input({ kind: 'person_loan', amount: 25, personId: 'debtor' }), '2026-09-06T00:00:03.000Z'),
    ]);

    expect(projected.balances.people.supplier).toBe(-290); // -300 - 40 + 50
    expect(projected.balances.people.debtor).toBe(225);
    expect(projected.balances.totalCash).toBe(1425); // payment 50 + loan 25 leave cash
  });

  it('projects new project receipts once and does not double-count a linked receipt', () => {
    const projected = projectOfflineBook(baseBook(), [
      queued('new-receipt', input({ kind: 'receipt', amount: 75, projectId: 'p1' }), '2026-09-06T00:00:01.000Z'),
      queued('bank-existing', input({ kind: 'receipt', amount: 25, projectId: 'p1', linkReceiptId: 'legacy-receipt' }), '2026-09-06T00:00:02.000Z'),
    ]);

    expect(projected.balances.projects.p1).toBe(1075);
    expect(projected.balances.accounts.a_cash).toBe(1100);
    expect(projected.balances.totalCash).toBe(1600);
  });

  it('keeps historical entries out of projected cash', () => {
    const projected = projectOfflineBook(baseBook(), [queued('history', input({ historical: true, amount: 400 }))]);
    expect(projected.balances.accounts.a_cash).toBe(1000);
    expect(projected.balances.totalCash).toBe(1500);
    expect(projected.entries).toHaveLength(1);
  });

  it('does not project a queued client reference already present in the confirmed snapshot', () => {
    const confirmed = baseBook();
    confirmed.entries.push({
      ...input({ clientRef: 'same' }),
      id: 'server-entry',
      effects: [{ type: 'account', targetId: 'a_cash', delta: -100 }],
      correctedFrom: null,
      createdAt: '2026-09-06T00:00:00.000Z',
    });
    const projected = projectOfflineBook(confirmed, [queued('same', input({ clientRef: 'same' }))]);
    expect(projected).toBe(confirmed);
    expect(projected.entries).toHaveLength(1);
    expect(projected.balances.accounts.a_cash).toBe(1000);
  });

  it('orders projected rows by queue time regardless of input array order', () => {
    const projected = projectOfflineBook(baseBook(), [
      queued('later', input({ purpose: 'Later' }), '2026-09-06T00:00:02.000Z'),
      queued('earlier', input({ purpose: 'Earlier' }), '2026-09-06T00:00:01.000Z'),
    ]);
    expect(projected.entries.map((entry) => entry.purpose)).toEqual(['Earlier', 'Later']);
    expect(projected.balances.accounts.a_cash).toBe(800);
  });
});
