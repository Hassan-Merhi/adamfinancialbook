import { describe, expect, it } from 'vitest';
import { classifyLiveMutation } from './live-refresh';

describe('live mutation refresh classification', () => {
  it('ignores reads and authentication-only writes', () => {
    expect(classifyLiveMutation('/api/overview', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/login', 'POST')).toBeNull();
    expect(classifyLiveMutation('/api/security/reauth', 'POST')).toBeNull();
  });

  it('refreshes both financial and dashboard state after entry changes', () => {
    expect(classifyLiveMutation('/api/entries', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/entries/ent_1', 'PATCH')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/entries/ent_1/void', 'POST')).toEqual({ book: true, dashboard: true });
  });

  it('refreshes book structure changes without relying on a page reload', () => {
    expect(classifyLiveMutation('/api/accounts', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/reminders/rem_1', 'DELETE')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/reset-book', 'POST')).toEqual({ book: true, dashboard: true });
  });

  it('knows which delegated actions actually alter the ledger', () => {
    expect(classifyLiveMutation('/api/delegation/transfers/tr_1/confirm', 'POST'))
      .toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/transfers/tr_1/reject', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/approvals/ap_1/decision', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/expense-reviews/assign', 'POST'))
      .toEqual({ book: true, dashboard: true });
  });

  it('refreshes delegation state after user/access writes', () => {
    expect(classifyLiveMutation('/api/users/usr_1/role', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/users/usr_1/accounts', 'PUT'))
      .toEqual({ book: false, dashboard: true });
  });
});
