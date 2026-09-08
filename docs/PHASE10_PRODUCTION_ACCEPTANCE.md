# Phase 10 — Production Acceptance

Phase 10 is the post-release acceptance layer for Adam Financial Book. It verifies that a revision which passed repository certification also became a healthy, usable production revision.

## Automated production acceptance

`Production Acceptance Certification` runs on every push to `main` and waits for Render to report the exact GitHub SHA through `/api/health/ready`.

The acceptance probe is read-only. It performs GET requests only and does not create, correct, void, transfer, upload, delete, or otherwise mutate financial data.

A release passes only when all of the following are true on the exact deployed SHA:

- readiness returns HTTP 200 and `ok: true`
- the reported production release equals the exact `main` SHA
- database readiness is `ok`
- migrations are `current`
- pending migrations are zero
- current migration equals latest migration
- off-site encrypted backup state is `current`
- PostgreSQL pool waiting clients are zero
- pool total does not exceed its configured maximum
- public liveness is healthy
- health responses are explicitly `Cache-Control: no-store`
- anonymous access to `/api/overview` remains rejected
- anonymous access to `/api/operations/observability` remains rejected
- three repeated readiness samples remain healthy on the exact release

## Evidence

A successful production run retains:

`production-acceptance-certification-<sha>`

for 90 days. The JSON evidence contains the exact release SHA, migration state, backup freshness, database pool state, anonymous-protection results, and repeated stability samples.

The stable-release tag workflow requires both the successful exact-SHA `Production Acceptance Certification` workflow and this retained exact-SHA artifact.

## Release sequence

1. Merge only after the PR certification matrix is green.
2. Wait for the exact `main` SHA to deploy.
3. Production Deploy Certification proves the exact SHA is serving.
4. Encrypted Production Backup produces retained exact-SHA backup evidence.
5. Final Production Certification proves repository/database certification.
6. Production Acceptance Certification proves the deployed release remains healthy and protected.
7. Real Device Mobile Certification supplies physical iPhone/Android evidence for the same SHA.
8. Only then may Stable Release Tag create the final stable tag.

## What Phase 10 does not fake

CI cannot truthfully certify physical touch behavior, camera/file picker behavior, installed-PWA behavior, cellular/Wi-Fi transitions, or OS-specific keyboard behavior without real devices. Those remain covered by the existing Real Device Mobile Certification gate and must use actual evidence.

## Rollback rule

Do not tag a release if production acceptance fails. A failed acceptance run is release evidence that the deployed SHA is not ready to be treated as stable, even if its repository CI was green.
