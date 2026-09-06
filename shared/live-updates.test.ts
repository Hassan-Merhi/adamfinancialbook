import { describe, expect, it } from 'vitest';
import { classifyLiveMutation, classifyLiveTopics } from './live-updates';

describe('shared live-update routing', () => {
  it('classifies the mutations that must propagate to other devices', () => {
    expect(classifyLiveMutation('/api/entries', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/entries/ent_1/void', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/transfers/tr_1/confirm', 'POST'))
      .toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/users/u_1/accounts', 'PUT'))
      .toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/approvals/ap_1/decision', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/users/u_1/role', 'POST')).toEqual({ book: false, dashboard: true });
  });

  it('routes mounted page datasets without leaking record identifiers', () => {
    expect(classifyLiveTopics('/api/entries', 'POST')).toEqual(['approvals', 'history']);
    expect(classifyLiveTopics('/api/accounts/a_1', 'PATCH')).toEqual(['approvals', 'access', 'history']);
    expect(classifyLiveTopics('/api/users/u_1/role', 'POST')).toEqual(['approvals', 'access', 'history']);
    expect(classifyLiveTopics('/api/delegation/users/u_1/accounts', 'PUT'))
      .toEqual(['approvals', 'access', 'history']);
    expect(classifyLiveTopics('/api/delegation/attachments', 'POST'))
      .toEqual(['approvals', 'files', 'history']);
    expect(classifyLiveTopics('/api/reset-book', 'POST'))
      .toEqual(['approvals', 'access', 'files', 'history']);
  });

  it('never broadcasts reads or session-only writes as book changes', () => {
    expect(classifyLiveMutation('/api/overview', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/live-updates', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/logout', 'POST')).toBeNull();
    expect(classifyLiveMutation('/api/security/reauth', 'POST')).toBeNull();
    expect(classifyLiveTopics('/api/overview', 'GET')).toEqual([]);
    expect(classifyLiveTopics('/api/security/reauth', 'POST')).toEqual([]);
  });
});
