# Phase 2 — Cross-device real-time updates

Phase 2 adds authenticated server push so a successful mutation on one signed-in device updates other open devices without polling or page reloads.

## Transport

- PostgreSQL `NOTIFY` distributes mutation signals across app instances.
- Authenticated Server-Sent Events at `/api/live-updates` push those signals to browsers.
- Each browser tab gets a session-scoped live client id. Writes carry that id in `x-live-client`, so the originating tab ignores its own server echo.
- EventSource reconnects automatically. The client closes the stream while offline and reopens it when connectivity returns.

## Safety

- The server publishes only after a successful response finishes.
- Failed writes do not emit live-update events.
- The payload contains only invalidation scope (`book`, `dashboard`) and timing metadata; no financial values are broadcast.
- Accounting rules, offline queue ordering, idempotency, and audit behavior are unchanged.
- Existing Phase 1 revalidation remains the only code that reloads shared snapshots, so real-time push does not create a second balance-calculation path.
