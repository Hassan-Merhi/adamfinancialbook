# P1 Hardening Certification

P1 is the release-certification layer for offline/reconnect safety, production-sized scale, and phone/mobile behavior. It does not change accounting semantics.

## 1. Offline / reconnect torture gate

Permanent automated coverage already lives in the Phase 7 client and PostgreSQL suites and remains required in CI.

Certified cases include:

- 1, 100, and 1,000 queued financial writes
- duplicate reconnect / online-event storms
- connection loss after the server accepted a write; retry uses the same idempotency key
- app/process death while a row is `syncing`; startup recovery preserves the same key
- server deploy/restart in the middle of a batch; later work remains durably queued and resumes in order
- session expiration/revocation during a batch
- disabled user and password/token revocation while offline
- same-device logout/login quarantine between different users
- two-phone stale-spend and stale-transfer races
- concurrent duplicate replay and exactly-once `client_ref` behavior
- correction / void precondition conflicts and safe owner review
- queued setup parent dependencies and conflicts
- uncertain receipt-response replay and interrupted receipt upload recovery
- receipt reconnect storms
- lost live/SSE delivery safety: authoritative reload/reconnect paths remain the source of truth
- installed PWA airplane-mode startup and restart recovery
- deterministic enqueue order when the device wall clock moves backwards
- final PostgreSQL integrity certification after chaos

The regression for a bad device clock is `client/src/p1-offline-clock.test.ts`. Durable queue order comes from sync sequence metadata rather than timestamps.

## 2. Production-scale PostgreSQL gate

`npm run test:p1-scale` creates and certifies a synthetic book with:

- 100 businesses
- 1,000 accounts
- 30 users
- 250,000 ledger entries
- 50,000 transfers included in those entries
- 100,000 audit rows
- 25,000 receipt/file attachments
- five years of historical dates

The gate enforces:

- focused statement p95 < 500 ms
- global entry search p95 < 500 ms
- audit-history page p95 < 500 ms
- file-library page p95 < 500 ms
- normal overview p95 < 500 ms
- heavy historical overview p95 < 1.5 s
- 30 simultaneous authenticated users with p95 < 1 s and total wall time < 2.5 s
- bounded response sizes
- required performance indexes
- no orphan effects
- exactly two active account effects for every seeded transfer

CI runs this in an isolated PostgreSQL 16 service so its dataset cannot hide failures in the ordinary integration suite.

## 3. Phone / mobile browser gate

`npm run test:p1-mobile` runs the built production client and server in WebKit with touch/mobile semantics at these viewport sizes:

- 320 × 568
- 375 × 812
- 393 × 852
- 430 × 932

The automated WebKit gate exercises:

- first-owner setup and signed-in startup
- Today, Money, Projects, and People
- every page under More
- global search
- Arabic RTL and return to LTR
- reduced-motion preference
- 44 × 44 minimum mobile navigation targets
- horizontal-overflow detection after each major navigation path
- keyboard focus entry
- an active, controlling service worker
- the expected `book-shell-v2` cache
- cached `/` and `/index.html` PWA app shells
- unhandled WebKit page errors

Airplane-mode startup, killed-app recovery, queued-write recovery, reconnect storms, and offline restart are certified by the permanent Phase 7/P1 offline suites rather than by Playwright's WebKit `setOffline()` transport. Playwright WebKit currently throws an engine-level internal navigation error when forced offline before a service-worker navigation, so the release gate intentionally separates browser rendering/PWA-install proof from offline-state-machine/restart proof instead of treating that engine error as an application result.

This is an executable WebKit/Safari-engine mobile gate, not a claim that CI owns physical iPhone hardware. It catches layout, touch, PWA installation/cache, RTL, accessibility, and navigation failures that static CSS assertions cannot, while the offline suites independently prove the data-safety behavior.

## Release rule

P1 may merge only when the PR head passes all of the following and the resulting `main` merge commit passes the normal production gates again:

1. TypeScript
2. all unit/regression tests
3. production build
4. migrations and migration idempotency
5. existing API integration suite
6. offline chaos and multi-device PostgreSQL certification
7. P1 production-scale PostgreSQL certification
8. P1 WebKit touch/mobile + service-worker/cache certification
9. financial end-to-end reconciliation
10. final database integrity certification
11. dependency/secret security gate
12. CodeQL high/critical gate
13. production deploy certification on the exact merge SHA
14. encrypted production backup on the exact merge SHA

There is no new production database migration in P1.
