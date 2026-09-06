# Phase 3 — Targeted, permission-aware real-time updates

Phase 3 narrows Phase 2's cross-device server push so unrelated delegated users do not re-fetch one another's snapshots.

## Audience rules

- Owners receive all financial/delegation invalidations relevant to administration.
- Entry-only users receive book invalidations only when a mutation touches one of their assigned accounts, or when their own account assignment changes.
- Transfer events target the recipient and users assigned to the source/destination accounts, plus owners.
- Approval events target the requester/assigned account user, plus owners.
- User/access administration targets owners plus the affected user where an existing user id is known.
- Owner-only setup/catalog writes remain owner-only unless they directly reshape a delegate's assigned-book view.
- Full book reset is intentionally broadcast to every authenticated user.

## Safety and performance

- Audience metadata stays inside the server/PG `NOTIFY` payload and is stripped before SSE data is sent to a browser.
- No balances, transaction values, usernames, permission lists or account ids are sent in the live event.
- If audience resolution has a transient database error, the signal falls back to all authenticated clients so correctness wins over optimization; normal authorized GET endpoints still enforce data access.
- The source tab is still de-duplicated by its session-scoped live client id.
- No polling was added.

## Correctness fix

Changing a delegated user's assigned accounts now marks both the delegation dashboard and that user's book snapshot stale, so an already-open delegated session immediately gains/loses the correct account view without a page refresh.
