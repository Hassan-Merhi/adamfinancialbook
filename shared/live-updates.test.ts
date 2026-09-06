import { describe, expect, it } from 'vitest';
import { classifyLiveMutation } from './live-updates';

describe('shared live-update routing', () => {
  it('classifies the mutations that must propagate to other devices', () => {
    expect(classifyLiveMutation('/api/entries', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/entries/ent_1/void', 'POST')).toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/transfers/tr_1/confirm', 'POST'))
      .toEqual({ book: true, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/approvals/ap_1/decision', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/users/u_1/role', 'POST')).toEqual({ book: false, dashboard: true });
  });

  it('never broadcasts reads or session-only writes as book changes', () => {
    expect(classifyLiveMutation('/api/overview', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/live-updates', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/logout', 'POST')).toBeNull();
    expect(classifyLiveMutation('/api/security/reauth', 'POST')).toBeNull();
  });
});
