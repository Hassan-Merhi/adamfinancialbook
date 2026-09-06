import { describe, expect, it } from 'vitest';
import {
  ALL_LIVE_TOPICS,
  classifyLiveMutation,
  parseLiveSessionRefresh,
} from './live-refresh';

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

  it('refreshes delegation state and the affected delegate book after access writes', () => {
    expect(classifyLiveMutation('/api/users/usr_1/role', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/users/usr_1/accounts', 'PUT'))
      .toEqual({ book: true, dashboard: true });
  });

  it('covers every independently loaded Phase 4 dataset during gap recovery', () => {
    expect(ALL_LIVE_TOPICS).toEqual(['approvals', 'access', 'files', 'history']);
    expect(new Set(ALL_LIVE_TOPICS).size).toBe(ALL_LIVE_TOPICS.length);
  });

  it('accepts only the value-free Phase 6 session refresh signal', () => {
    expect(parseLiveSessionRefresh('{"state":"refresh","at":1234}', 99)).toBe(1234);
    expect(parseLiveSessionRefresh('{"state":"refresh"}', 99)).toBe(99);
    expect(parseLiveSessionRefresh('{"state":"revoked","at":1234}', 99)).toBeNull();
    expect(parseLiveSessionRefresh('{bad json', 99)).toBeNull();
  });
});
