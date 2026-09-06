# Phase 5 — Reconnect and missed-event recovery

Phases 1–4 made successful writes update the current app and other authorized devices in real time. Phase 5 closes the remaining correctness gap: PostgreSQL `NOTIFY` and SSE are intentionally ephemeral, so a phone that was offline or suspended cannot replay notifications that happened while it was disconnected.

## Recovery triggers

The client performs one authoritative catch-up when:

- the browser crosses from offline to online;
- the SSE transport reconnects after an error while the browser still reports online;
- the app returns from a meaningful background suspension (15 seconds or more).

Short tab/app switches do not cause a refresh.

## Recovery behavior

A recovery is routed through the existing live invalidation system:

- shared book / balances revalidate;
- delegation / attention dashboard revalidates;
- mounted Approvals / My wallet, Access, Receipts & files, and History pages revalidate;
- unrelated app chrome, prompt, navigation and pages remain mounted.

The existing offline subsystem continues to flush queued financial work on the browser `online` event. Successful queued writes emit normal mutation invalidations, and the projected-book layer keeps unsynced rows over the latest confirmed server snapshot. This means a catch-up cannot silently discard offline work.

If the browser says it is online but the server is still unreachable, the immediate recovery may fail safely against the existing cached snapshot. The SSE connection records the transport gap; when it eventually opens successfully, the client performs another catch-up. No polling loop is added.

## Safety

- Recovery events contain no account ids, user ids, balances, transaction amounts, names, permissions or audit details.
- Financial state is always refetched from the authorized server endpoints.
- No accounting rules or database schema changed.
- No event replay buffer is trusted for accounting correctness.
- No SQL/TablePlus migration is required.
