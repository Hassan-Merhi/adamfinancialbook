import { describe, expect, it } from 'vitest';
import {
  classifyLiveSessionControl,
  liveSessionControlMatches,
  preserveReplacementSession,
} from './live-session-control';

const actor = 'usr_owner';
const currentSession = 'ses_current';

function classify(path: string, method = 'POST') {
  return classifyLiveSessionControl(path, method, actor, currentSession);
}

describe('Phase 6 live session revocation policy', () => {
  it('closes the exact session that signs out', () => {
    expect(classify('/api/logout')).toEqual({
      userId: actor,
      sessionId: currentSession,
      exceptSessionId: null,
      reason: 'logout',
    });
  });

  it('closes every existing stream after credential or role changes', () => {
    expect(classify('/api/password')).toEqual({
      userId: actor,
      sessionId: null,
      exceptSessionId: null,
      reason: 'credential-change',
    });
    expect(classify('/api/users/usr_delegate/password')).toMatchObject({
      userId: 'usr_delegate', reason: 'credential-change', sessionId: null,
    });
    expect(classify('/api/users/usr_delegate/username')).toMatchObject({
      userId: 'usr_delegate', reason: 'credential-change', sessionId: null,
    });
    expect(classify('/api/users/usr_delegate/role')).toMatchObject({
      userId: 'usr_delegate', reason: 'role-change', sessionId: null,
    });
  });

  it('preserves the newly issued session after a same-user credential or role change', () => {
    const credential = preserveReplacementSession(
      classify('/api/password')!,
      actor,
      currentSession,
      'ses_replacement',
    );
    expect(credential.exceptSessionId).toBe('ses_replacement');
    expect(liveSessionControlMatches(credential, {
      userId: actor,
      securitySessionId: 'ses_replacement',
    })).toBe(false);
    expect(liveSessionControlMatches(credential, {
      userId: actor,
      securitySessionId: currentSession,
    })).toBe(true);

    const otherUser = preserveReplacementSession(
      classify('/api/users/usr_delegate/role')!,
      actor,
      currentSession,
      'ses_replacement',
    );
    expect(otherUser.exceptSessionId).toBeNull();
  });

  it('immediately closes every stream for a disabled user', () => {
    expect(classify('/api/users/usr_delegate', 'DELETE')).toEqual({
      userId: 'usr_delegate',
      sessionId: null,
      exceptSessionId: null,
      reason: 'access-disabled',
    });
  });

  it('keeps the current session when MFA deliberately revokes only the others', () => {
    const control = classify('/api/security/mfa/enable');
    expect(control).toEqual({
      userId: actor,
      sessionId: null,
      exceptSessionId: currentSession,
      reason: 'mfa-change',
    });
    expect(liveSessionControlMatches(control!, {
      userId: actor,
      securitySessionId: currentSession,
    })).toBe(false);
    expect(liveSessionControlMatches(control!, {
      userId: actor,
      securitySessionId: 'ses_other',
    })).toBe(true);
  });

  it('targets one revoked security session without disturbing sibling sessions', () => {
    const control = classify('/api/security/sessions/ses_other', 'DELETE');
    expect(control).toEqual({
      userId: actor,
      sessionId: 'ses_other',
      exceptSessionId: null,
      reason: 'session-revoked',
    });
    expect(liveSessionControlMatches(control!, {
      userId: actor,
      securitySessionId: 'ses_other',
    })).toBe(true);
    expect(liveSessionControlMatches(control!, {
      userId: actor,
      securitySessionId: currentSession,
    })).toBe(false);
  });

  it('closes all streams for revoke-all and never crosses user boundaries', () => {
    const control = classify('/api/security/sessions/revoke-all');
    expect(control).toMatchObject({
      userId: actor,
      sessionId: null,
      exceptSessionId: null,
      reason: 'all-sessions-revoked',
    });
    expect(liveSessionControlMatches(control!, {
      userId: actor,
      securitySessionId: 'ses_any',
    })).toBe(true);
    expect(liveSessionControlMatches(control!, {
      userId: 'usr_someone_else',
      securitySessionId: 'ses_any',
    })).toBe(false);
  });

  it('does not invent revocation for non-revoking security actions or unauthenticated requests', () => {
    expect(classify('/api/security/mfa/setup')).toBeNull();
    expect(classify('/api/security/reauth')).toBeNull();
    expect(classify('/api/users/usr_delegate/restore')).toBeNull();
    expect(classifyLiveSessionControl('/api/password', 'POST', null, null)).toBeNull();
  });
});
