# Adam Financial Book

Adam Financial Book is a private operational money-control system. It keeps five ideas separate:

- where money is held;
- which business owns it;
- which project received or spent it;
- which person or supplier it concerns; and
- who owes whom.

The interface stays simple while strict ownership, duplicate protection, historical-data separation and audit-safe correction rules live underneath.

## Current milestone — Phase 1

The first working milestone provides persistent master-data setup for:

- businesses;
- cash, bank, mobile-money and card accounts;
- projects;
- people, employees, suppliers and clients; and
- permitted business-to-business loan or paid-on-behalf relationships.

The database starts empty. It does not seed example companies, accounts, balances or historical transactions. The owner creates only the records that really exist.

## Safety rules already enforced

- Every money account belongs to exactly one business.
- Projects belong to one business but do not become cash balances.
- Duplicate names are blocked within their proper scope.
- Business relationships contain no opening debt by default.
- Records are scoped to the signed-in owner.
- A business cannot be deleted while accounts, projects or relationships still depend on it.
- USD and CDF remain explicit, separate currencies.

## Planned next milestone

Phase 2 will add historical-data reconciliation and the transaction engine. That engine will record a real event once while producing the necessary cash, project and obligation effects. Quick Log remains intentionally locked until that engine exists.

## Technology

- React 19 and Vinext
- Cloudflare Workers-compatible server output
- Cloudflare D1 for durable relational data
- Drizzle schema and checked-in SQL migrations
- Owner identity from the authenticated workspace request

## Local development

Requirements: Node.js 22.13 or newer, Linux, `flock`, `curl` and GNU `timeout`.

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run lint
npm exec tsc -- --noEmit
npm run db:generate
```

The hosted environment supplies the real D1 binding declared in `.openai/hosting.json`.
