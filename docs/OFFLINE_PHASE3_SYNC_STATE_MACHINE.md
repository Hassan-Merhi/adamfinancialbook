# Advanced Offline Phase 3 — Sync State Machine

Phase 3 makes every queued financial write explicit, durable and retry-safe. It builds on the existing Phase 1 per-user IndexedDB stores and Phase 2 projected balances. It does not change the Phase 1 IndexedDB schema/version.

## Durable states

Each queued entry has user-scoped metadata in the existing `syncMeta` IndexedDB store:

- `pending` — stored locally and ready to send.
- `syncing` — a request is in flight.
- `retry_wait` — the request failed transiently and remains stored until its next retry.
- `blocked_auth` — the authenticated session expired; the entry stays stored until the same user signs in again/retries.
- `rejected` — the server permanently refused the operation. It stays stored and blocks later financial writes from overtaking it.

A successful server acknowledgement removes the outbox row and its sync metadata. Server data and its audit trail become the durable proof of acceptance.

## Ordering and projected balances

The outbox is always processed oldest first. A transient failure pauses the run. An authentication block pauses the run. A permanent rejection also pauses the run and prevents all later entries from syncing.

Phase 2 projection continues while entries are pending, syncing, retrying or waiting for authentication. Projection stops at the first rejected entry, because later local effects cannot safely be shown as though the rejected server operation had succeeded.

Detailed conflict resolution and rebase/review rules belong to Phase 4.

## Retry policy

Retryable failures are:

- network/fetch failures,
- HTTP 408,
- HTTP 425,
- HTTP 429,
- HTTP 5xx.

Automatic retry uses exponential backoff beginning at 2 seconds and capped at 5 minutes. Reconnect, sign-in and application foreground flows can also trigger a flush. Concurrent flush triggers share one in-flight run so the same browser does not send one queue row twice at once.

Permanent 4xx failures are stored as `rejected`; they are never silently deleted.

## Crash recovery

Before a request is sent, its state is durably changed to `syncing`. If the browser closes or crashes while it is in that state, startup converts it to an immediately due `retry_wait` state. The retry uses the exact same `clientRef`.

If the server committed an operation but the browser never received the response, retrying the same key returns the already-created server object rather than creating another financial event.

## Idempotency

Ordinary ledger entries already use the unique `entries.client_ref` key.

Delegated-wallet handoffs now preserve that same offline `clientRef` through the client fallback. The authenticated server route derives a deterministic pending-transfer ID from the requesting user plus `clientRef`, inserts it with `ON CONFLICT (id) DO NOTHING`, and returns the existing handoff on a replay.

Reusing one key with different transfer details is rejected with `IDEMPOTENCY_KEY_REUSED`.

The first creation writes the pending transfer, recipient notification and audit line in one PostgreSQL transaction. A replay writes none of them again. When the recipient confirms the handoff, the existing accounting-integrity trigger still creates/links exactly one ledger transfer using `handoff_<transfer id>`.

## Authentication and user isolation

Sync state remains scoped to the same user as the Phase 1 outbox. Sign-out does not expose another user's queued financial data. Before a flush reads the queue, it waits for that user's sync metadata to finish hydrating, preventing re-login from racing stale rejected/auth-blocked state.

## Certification

Phase 3 includes unit/regression coverage for:

- pending → syncing → acknowledged removal,
- network/server transient retry,
- bounded backoff,
- session expiry,
- permanent rejection,
- strict queue ordering,
- concurrent flush coalescing,
- crash-interrupted recovery,
- unchanged idempotency keys.

A real PostgreSQL integration test concurrently replays one delegated offline handoff and proves there is exactly one pending transfer, one notification, one audit event and—after recipient confirmation—one ledger transfer.

## Phase boundary

Phase 3 provides reliable transport/state semantics. Phase 4 owns richer conflict detection, stale-permission/balance conflict classification, financial safety decisions and user-facing resolution workflows. Attachments remain Phase 5; the full Sync Center/mobile management UI remains Phase 6; reconnect/chaos/multi-device certification remains Phase 7.
