export type LiveSessionControlReason =
  | 'logout'
  | 'credential-change'
  | 'role-change'
  | 'access-disabled'
  | 'mfa-change'
  | 'session-revoked'
  | 'all-sessions-revoked';

export interface LiveSessionControl {
  kind: 'session-control';
  userId: string;
  /** Close only this tracked security session when present. */
  sessionId: string | null;
  /** Keep this tracked session open while closing the user's other sessions. */
  exceptSessionId: string | null;
  reason: LiveSessionControlReason;
  at: number;
}

export interface LiveSessionIdentity {
  userId: string;
  securitySessionId: string | null;
}

export type LiveSessionControlTarget = Omit<LiveSessionControl, 'kind' | 'at'>;

function allUserSessions(
  userId: string,
  reason: LiveSessionControlReason,
  exceptSessionId: string | null = null,
): LiveSessionControlTarget {
  return { userId, sessionId: null, exceptSessionId, reason };
}

/**
 * Security writes that revoke durable sessions must also invalidate already-open
 * SSE connections. The HTTP security layer remains authoritative; this merely
 * mirrors its successful revocation boundary to every live app instance.
 */
export function classifyLiveSessionControl(
  path: string,
  method: string,
  actorUserId: string | null | undefined,
  actorSessionId: string | null | undefined,
): LiveSessionControlTarget | null {
  if (!actorUserId) return null;
  const verb = method.toUpperCase();
  const sessionId = actorSessionId ?? null;

  if (verb === 'POST' && path === '/api/logout') {
    return sessionId
      ? { userId: actorUserId, sessionId, exceptSessionId: null, reason: 'logout' }
      : allUserSessions(actorUserId, 'logout');
  }

  if (verb === 'POST' && path === '/api/password') {
    return allUserSessions(actorUserId, 'credential-change');
  }

  const userSecurity = /^\/api\/users\/([^/]+)\/(username|password|role)$/.exec(path);
  if (verb === 'POST' && userSecurity) {
    const targetUserId = userSecurity[1];
    return allUserSessions(
      targetUserId,
      userSecurity[2] === 'role' ? 'role-change' : 'credential-change',
    );
  }

  const disabledUser = /^\/api\/users\/([^/]+)$/.exec(path);
  if (verb === 'DELETE' && disabledUser) {
    return allUserSessions(disabledUser[1], 'access-disabled');
  }

  if (verb === 'POST' && (path === '/api/security/mfa/enable' || path === '/api/security/mfa/disable')) {
    // Those routes intentionally keep the current tracked session and revoke
    // every other session for the same user.
    return allUserSessions(actorUserId, 'mfa-change', sessionId);
  }

  const oneSession = /^\/api\/security\/sessions\/([^/]+)$/.exec(path);
  if (verb === 'DELETE' && oneSession) {
    return {
      userId: actorUserId,
      sessionId: oneSession[1],
      exceptSessionId: null,
      reason: 'session-revoked',
    };
  }

  if (verb === 'POST' && path === '/api/security/sessions/revoke-all') {
    return allUserSessions(actorUserId, 'all-sessions-revoked');
  }

  return null;
}

/**
 * Password/username/role changes can revoke every old session and issue a new
 * tracked session to the same browser before the response finishes. Preserve
 * that replacement session while closing the old generation everywhere else.
 */
export function preserveReplacementSession(
  control: LiveSessionControlTarget,
  actorUserId: string | null | undefined,
  beforeSessionId: string | null | undefined,
  afterSessionId: string | null | undefined,
): LiveSessionControlTarget {
  const replacement = afterSessionId ?? null;
  if (
    control.userId === actorUserId
    && replacement
    && replacement !== (beforeSessionId ?? null)
    && (control.reason === 'credential-change' || control.reason === 'role-change')
  ) {
    return { ...control, exceptSessionId: replacement };
  }
  return control;
}

export function liveSessionControlMatches(
  control: Pick<LiveSessionControl, 'userId' | 'sessionId' | 'exceptSessionId'>,
  identity: LiveSessionIdentity,
): boolean {
  if (control.userId !== identity.userId) return false;
  if (control.sessionId && control.sessionId !== identity.securitySessionId) return false;
  if (control.exceptSessionId && control.exceptSessionId === identity.securitySessionId) return false;
  return true;
}
