# Advanced Offline Phase 7 — Reconnect, Chaos & Multi-Device Certification

Phase 7 is the final certification layer for the advanced offline-sync program. It does not change ledger semantics. It proves that the Phase 1–6 storage, projection, sync, conflict, receipt, and UX layers remain safe when the phone, network, session, server, or another device behaves badly.

## Permanent CI gates

`npm test` includes `client/src/offline-phase7.test.ts`.

`npm run test:offline-chaos` runs `server/offline-chaos.integration.test.ts` against a real PostgreSQL database and is a named required step in `.github/workflows/ci.yml` before the existing financial E2E and final integrity certification.

## Certified client chaos cases

- app already installed, then starts with no network: service worker shell/navigation fallback remains wired
- 1 queued transaction
- 100 queued transactions
- 1,000 queued transactions
- all 1,000 drain in durable enqueue order with unique stable client references
- duplicate reconnect/online events coalesce into one active flush
- server restart/503 in the middle of a batch leaves the failed item and every later item queued, then resumes in order
- connection disappears after the server logically accepted a request: retry reuses the exact same idempotency key
- app is killed while an item is `syncing`: startup recovery moves it to an immediate retry without changing its key
- session expires/revokes during a batch: already acknowledged work stays posted, the blocked item and later work stay local, and same-user sign-in resumes safely
- logout/login preserves the original user's queue and hides it completely from a different user on the same device
- receipt reconnect storms coalesce and upload every receipt once
- interrupted `uploading` receipt state is explicitly recovered to `waiting`
- every original client reference is accounted for exactly once as either server-acknowledged or still durably queued; no item silently disappears

## Certified PostgreSQL / multi-device cases

- 40 simultaneous replays of the same offline transaction create one logical ledger entry
- two different users spending the same stale account concurrently: exactly one posts and one receives a conflict
- two conflicting transfers from the same source concurrently: exactly one posts, the source cannot overdraw, and source + destinations conserve the original total
- password/token revocation while a device is offline: the old session receives 401 and cannot post queued money movement
- disabled user while offline: the old session receives 401 and cannot post queued money movement
- no duplicate non-null `client_ref` rows after the stress run
- `server/integrity-check.ts` must return green on the chaos-populated database

The earlier Phase 4 integration test remains part of the normal integration suite and separately certifies two-phone/same-user stale spending, access removal, stale rebasing, and idempotent delegated handoff replay. Phase 5 separately certifies uncertain receipt-response replay with a stable attachment id.

## Release rule

The advanced offline program is production-certified only when all of the following pass on the exact PR head and again on the resulting `main` merge commit:

1. TypeScript
2. all unit/regression tests, including the Phase 7 client chaos suite
3. production build
4. migrations and migration idempotency
5. existing API integration suite
6. Phase 7 offline chaos and multi-device PostgreSQL certification
7. financial E2E reconciliation
8. final database integrity certification
9. dependency/secret security gate
10. CodeQL high/critical gate

There is no new database migration in Phase 7.
