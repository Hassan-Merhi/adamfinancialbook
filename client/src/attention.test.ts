import { describe, expect, it } from 'vitest';
import { attentionCounts } from './attention';
import type { EvidenceDashboard, LoadedBook } from './api';

const book: LoadedBook = {
  businesses: [{ id: 'b1', name: 'Construction' }],
  accounts: [{ id: 'a1', name: 'Cash', businessId: 'b1', opening: 1000 }],
  projects: [{ id: 'p1', name: 'Site', scope: '', businessId: 'b1' }],
  receipts: [
    { id: 'r1', projectId: 'p1', occurredOn: '2026-09-01', amount: 200, inCash: false, entryId: null },
    { id: 'r2', projectId: 'p1', occurredOn: '2026-09-02', amount: 50, inCash: true, entryId: 'e2' },
  ],
  people: [],
  loans: [],
  entries: [],
  reminders: [
    { id: 'm1', what: 'Pay fuel', amount: 30, accountId: 'a1', note: '', settled: false },
    { id: 'm2', what: 'Done', amount: 10, accountId: 'a1', note: '', settled: true },
  ],
  balances: { totalCash: 1000, accounts: { a1: 1000 }, businesses: { b1: 1000 }, people: {}, loans: {}, projects: {} },
};

const dashboard: EvidenceDashboard = {
  mode: 'owner',
  approvals: [
    { id: 'q1', request_text: 'Buy cement', amount: 100, status: 'pending', created_at: '2026-09-05T10:00:00Z' },
    { id: 'q2', request_text: 'Old', amount: null, status: 'approved', created_at: '2026-09-04T10:00:00Z' },
  ],
  pendingTransfers: [{
    id: 't1', amount: 75, purpose: 'Petty cash', from_account_id: 'a1', to_account_id: 'a2',
    from_account_name: 'Cash', to_account_name: 'Wallet', created_at: '2026-09-05T10:00:00Z',
  }],
  recentActivity: [],
  notifications: [],
  expenseReviews: [{
    id: 'e-review', occurred_on: '2026-09-05', amount: 40, purpose: 'Fuel', raw: 'fuel',
    account_id: 'a1', account_name: 'Cash', payer_business_id: 'b1', payer_business_name: 'Construction',
    actor_email: 'delegate@example.com', created_at: '2026-09-05T10:00:00Z',
  }],
};

describe('unified needs-attention count', () => {
  it('counts only unresolved work across all sources', () => {
    expect(attentionCounts(book, dashboard, 2)).toEqual({
      reviews: 1,
      approvals: 1,
      transfers: 1,
      reminders: 1,
      receiptsWaiting: 1,
      missingEvidence: 2,
      total: 7,
    });
  });

  it('still counts book-local items when the delegation dashboard is unavailable', () => {
    expect(attentionCounts(book, null).total).toBe(2);
  });
});
