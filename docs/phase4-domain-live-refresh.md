# Phase 4 — Domain-aware live page refresh

Phase 4 completes the frontend subscription layer for data that is not owned by the shared `/api/overview` and delegation-dashboard state in `App`.

## What now updates automatically

- **Approvals / My wallet** revalidates when a relevant account balance, delegated transfer, approval, account assignment, or user change reaches that authorized client.
- **Access** revalidates when users, account assignments, account definitions, or a full-book reset changes.
- **Receipts & files** revalidates when evidence is uploaded/reset and when access/user metadata relevant to its filters changes.
- **History** revalidates after any propagated mutation that can add an audit event.

The application shell, prompt, navigation, and unrelated pages are never reloaded.

## Topic contract

The server adds only these value-free topic labels to an already-authorized SSE invalidation:

- `approvals`
- `access`
- `files`
- `history`

Topics contain no account ids, user ids, names, balances, transaction values, permission lists, or audit details. Normal authorized GET endpoints remain the only source of financial/user data.

## Performance and correctness

- Topic listeners are active only while their route-sized page is mounted.
- Bursts are coalesced before revalidation.
- Existing local page actions that already reload themselves are not redundantly remounted where the mutation path is known.
- Cross-device and cross-instance updates continue to use Phase 2 PostgreSQL `NOTIFY` + SSE and Phase 3 permission-aware audiences.
- No polling was added.
- A rolling-deploy compatibility fallback widens topic refreshes only when a Phase 3 instance publishes the legacy payload without topics, preventing stale data during deployment.
- No database schema or accounting rules changed.
