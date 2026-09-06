# Advanced Offline Phase 1 — IndexedDB foundation

## Purpose

Move sensitive offline financial state out of global `localStorage` keys and into a durable, versioned, per-user IndexedDB database before the later projected-balance and conflict phases build on it.

## Database

Database: `adam-financial-book-offline`, version 1.

Stores:

- `meta` — active-user pointer and migration markers only.
- `profiles` — last authenticated profile, keyed by user id.
- `snapshots` — the last compact `/api/overview` snapshot for each user. This contains the accounts, balances, businesses, people, projects and bounded recent-entry data required for offline startup.
- `outbox` — queued financial entries. Records carry both a stable client reference and the owning user id; indexes preserve user/time lookup.
- `attachments` — reserved user-scoped storage for the later offline-receipt phase.
- `syncMeta` — reserved per-user sync metadata for the later sync-state phase.

No account, balance, transaction snapshot or outbox payload is intentionally written to localStorage after migration.

## Legacy migration

On startup, before React renders, the repository checks the old keys:

- `book.user`
- `book.snapshot`
- `book.outbox`

If the legacy user contains a valid user id, its snapshot and queued entries are adopted into that user's IndexedDB scope in one migration transaction. Existing IndexedDB records win over duplicate legacy records. The migration marker is written before the legacy keys are removed.

If IndexedDB cannot be opened, the application falls back to isolated in-memory state for the current session and leaves legacy localStorage untouched rather than deleting the only durable copy.

## User isolation

The active user id selects the only snapshot and outbox visible to the client facade. Switching users immediately switches scope. A queued entry cannot be created without an active user.

On explicit sign-out/session clearing:

- the active-user pointer is removed;
- the cached profile and snapshot are removed;
- queued unsent entries remain quarantined under the old user id.

That prevents another signed-in user from seeing or flushing someone else's queued financial work while avoiding silent loss of unsynced entries. Signing back into the original user re-associates that queue.

A successful owner data reset continues to clear the active outbox and snapshot so stale offline writes cannot be reintroduced into a fresh book.

## Phase boundary

Phase 1 intentionally does not add projected balances, rich sync states, conflict resolution or offline attachment uploads. The IndexedDB stores needed by those phases exist now so those features can be added without another storage migration.
