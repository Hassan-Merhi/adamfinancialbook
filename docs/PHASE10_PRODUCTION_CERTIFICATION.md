# Phase 10 — Final Production Certification + UX Polish

Phase 10 is the final release gate for Adam Financial Book. It does not introduce a new accounting model. It proves that the existing book is safe, fast, understandable, accessible, responsive, and recoverable as one production system.

## UX certification

The signed-in shell is certified around the prompt-first workflow and the five-item mobile navigation. Secondary pages remain lazy-loaded and the system does not return to periodic polling.

Final interaction requirements:

- `aria-current="page"` is the canonical active-navigation state on desktop and mobile.
- The More drawer and global search are true modal surfaces: focus moves inside, Tab/Shift+Tab stay inside, Escape closes, background scrolling is locked, and focus returns to the opener.
- Search and More cannot remain open on top of one another.
- Keyboard focus is visibly outlined.
- Touch-oriented controls meet a 44 px minimum target on coarse pointers without inflating dense desktop ledger rows.
- The sign-in screen uses native form submission and standard username/current-password/new-password autocomplete semantics.
- Page titles reflect the current area of the book.
- Explicit light/dark appearance survives reloads.
- Statement opening honors reduced-motion preferences.
- Offline state and queued-entry messaging remain visible and the service worker never caches API responses.

## Role and data visibility

Owner-only destinations stay filtered from entry users in navigation, prompt actions and global search. Server authorization remains authoritative; Phase 10 does not rely on UI hiding as a security boundary.

## Accounting/data certification

CI runs the following in order against PostgreSQL:

1. migrations;
2. migration idempotency;
3. migration-status verification;
4. API/security/performance/translation/recovery integration suites;
5. financial end-to-end reconciliation;
6. the full database integrity checker.

The final integrity step is mandatory. A build is not production-certified merely because TypeScript and UI tests pass.

For an already configured environment, the local/operator command is:

```sh
npm run certify:production
```

That runs typecheck, the full unit/regression suite, production build, migration-status verification and database integrity verification. Integration/financial E2E/recovery remain enforced by CI because they use disposable PostgreSQL state.

## Security certification

The separate Security workflow remains required for every Phase 10 PR and the merged `main` commit. It blocks dependency vulnerabilities at the configured thresholds, scans tracked source for obvious secrets, runs CodeQL, and blocks high/critical CodeQL findings.

## Production release definition

Phase 10 is complete only when all of these are true:

- final Phase 10 PR is mergeable and all CI/Security checks pass;
- the exact tested PR head is merged with SHA protection;
- push-triggered CI on the resulting `main` merge commit passes;
- push-triggered dependency/secret/CodeQL checks on that same merge commit pass;
- `main` still points to that verified merge commit after the checks finish.

Live hosting verification is reported separately when the connected hosting provider is available. Repository certification must never be represented as proof of a live deployment that could not be inspected.
