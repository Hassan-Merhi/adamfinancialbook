import { describe, expect, it } from 'vitest';
import { searchEverything } from './search';
import type { EvidenceDashboard, LoadedBook } from './api';

const book: LoadedBook = {
  businesses: [{ id: 'b1', name: 'Construction' }],
  accounts: [{ id: 'a1', name: 'Construction Cash', businessId: 'b1', opening: 1000 }],
  projects: [{ id: 'p1', name: 'Kin Severe', scope: 'Factory', businessId: 'b1' }],
  receipts: [],
  people: [{ id: 'd1', name: 'Dani Hardware', role: 'Supplier', businessId: 'b1', kind: 'payable', opening: 0, salary: 0 }],
  loans: [],
  entries: [{
    id: 'e1', occurredOn: '2026-09-05', kind: 'expense', amount: 900, purpose: 'STS chargeuse', raw: '$900 STS chargeuse construction cash',
    accountId: 'a1', toAccountId: null, projectId: null, personId: null, forBusiness: null, historical: false,
    linkReceiptId: null, clientRef: null, effects: [], correctedFrom: null, createdAt: '2026-09-05T10:00:00Z',
  }],
  reminders: [],
  balances: { totalCash: 100, accounts: { a1: 100 }, businesses: { b1: 100 }, people: { d1: 0 }, loans: {}, projects: { p1: 0 } },
};

const dashboard: EvidenceDashboard = {
  mode: 'owner',
  approvals: [{ id: 'q1', request_text: 'Buy generator', amount: 2000, status: 'pending', requester_email: 'dev@example.com', created_at: '2026-09-05T10:00:00Z' }],
  pendingTransfers: [],
  recentActivity: [],
  notifications: [],
  expenseReviews: [],
};

describe('global search', () => {
  it('finds named accounts and opens the right statement', () => {
    const hit = searchEverything('construction cash', book, dashboard, true)[0];
    expect(hit.title).toBe('Construction Cash');
    expect(hit.action).toEqual({ mode: 'focus', target: { type: 'account', id: 'a1' } });
  });

  it('finds activity and pending work', () => {
    expect(searchEverything('chargeuse', book, dashboard, true)[0].group).toBe('Activity');
    expect(searchEverything('generator', book, dashboard, true)[0].action).toEqual({ mode: 'view', view: 'attention' });
  });

  it('hides owner-only pages from entry-only users', () => {
    const hits = searchEverything('files receipts', book, dashboard, false);
    expect(hits.some((hit) => hit.id === 'page:files')).toBe(false);
  });
});
