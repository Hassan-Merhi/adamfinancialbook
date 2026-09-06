# Phase 6 — Live authority hardening and final certification

Phases 1–5 removed stale UI, added cross-device PostgreSQL-backed SSE, narrowed audiences, refreshed mounted domain pages, and recovered authoritative state after connection gaps. Phase 6 closes the remaining authorization boundary: a live stream must not outlive the durable security session that authorized it.

## Immediate live-session invalidation

Each SSE connection is bound to the authenticated user, role, browser live-client id, and durable security-session id that opened it.

Successful security writes publish a server-internal `session-control` message through the existing PostgreSQL `book_live_updates` channel. Every running app instance closes only the affected live connections for:

- logout;
- password changes and owner password resets;
- username changes;
- role changes;
- user disable;
- MFA enable/disable revocation of sibling sessions;
- individual security-session revocation;
- revoke-all sessions.

No database polling is added. The existing 20-second SSE comment heartbeat remains transport keepalive only and does not query authorization state.

When a same-browser password/username/role change revokes old sessions and issues a replacement session in the response, the replacement session is excluded from the close command. Old streams are still terminated everywhere else.

## Browser behavior

A revoked stream receives only:

```text
event: session
data: {"state":"refresh","at":...}
```

The browser never receives the control reason, user id, session id, role, username, financial value, or permission list. It closes EventSource before revalidating.

- If the browser already received a replacement cookie, the authoritative overview succeeds and realtime reconnects under the new authority.
- If the session is actually gone, the protected overview returns 401 and the app moves to signed-out state.

## Offline security boundary

A protected 401 is also authoritative evidence that the device session is no longer accepted. The client clears the active offline profile and cached snapshot before returning that response to the UI. The per-user durable outbox, attachment queue, and sync metadata are preserved, so queued financial work is not destroyed and cannot be exposed to another user.

Wrong-password credential checks (`/login`, `/security/reauth`, `/password`) are excluded because their 401 responses do not invalidate an otherwise healthy session.

## Middleware correction

Live mutation observation now runs in the authenticated public-router fallthrough before `protectedSecurityRouter`. This fixes a prior routing hole where protected security routes such as role changes could finish before the live observer was reached.

The SSE endpoint itself remains behind `requireAuthenticatedApi` and the `x-book` write gate remains unchanged.

## Permanent certification

Phase 6 adds:

- pure policy tests for session revocation targeting and user/session isolation;
- replacement-session preservation tests;
- browser parsing and offline quarantine policy tests;
- middleware-order/source contracts;
- a real PostgreSQL + real HTTP/SSE integration test proving that disabling a delegate:
  - emits the owner Access/dashboard invalidation;
  - sends only a value-free session refresh to the revoked delegate;
  - terminates the delegate live authority;
  - makes the revoked cookie fail protected reads immediately.

The integration test is part of the permanent `test:integration` CI gate.

## Safety and migration boundary

- No accounting rules changed.
- No balance calculation path changed.
- No event contains financial values.
- No polling loop was added.
- No database schema changed.
- No SQL/TablePlus migration is required.
