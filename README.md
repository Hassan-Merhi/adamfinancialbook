# Financial Book

A live money tracker for several businesses run out of one pocket. Not
accounting software: no chart of accounts, no journals, no double entry to
learn. You say what happened, and it keeps track of four things —

- **whose money** it is (which business),
- **where it is** (which cash box, bank or agent),
- **what it was for** (which project, person or purpose),
- and **whether anyone now owes anyone**.

## The one idea

An entry is a single event, and every consequence of that event is stored with
it as an **effect**. Balances are never written down anywhere — they are always
an opening figure plus the effects on top.

That single decision is what makes the book trustworthy:

- The same money can never be counted twice. A client payment is a receipt on
  the day the job pays; when that money later reaches an account it is a cash
  movement, not a second receipt.
- Any past day can be rebuilt exactly, because a balance is just the effects up
  to that date.
- A correction replaces an entry — old effects out, new ones in — instead of
  leaving two versions floating around.

## Rules the code enforces

| Rule | Where |
|---|---|
| Money leaving A for B always **reduces** "A owes B" — the direction is computed, never typed | `shared/engine.ts` → `withLoanEffects` |
| Goods taken on credit change what you owe, never what you have: no account is touched | `computeEffects`, `credit_purchase` |
| Minus means you owe it, plus means it is owed to you — one reading everywhere | `personBalance`, `loanFrom` |
| A receipt already recorded, only now arriving, moves cash and nothing else | `possibleDuplicateReceipt`, `receipt_banked` |
| A historical line updates the past and leaves today's cash alone | `historical` on an entry |
| A person's loan, their salary and their invoices stay in three separate columns | `PersonKind` |

Every one of these has a test in `shared/engine.test.ts`.

## Running it

```bash
npm install
cp .env.example .env      # then set DATABASE_URL
npm run db:setup          # creates the tables (safe to re-run)
npm run dev               # API on :5000, app on :5173
```

```bash
npm test         # the money rules
npm run typecheck
npm run build
```

## Deploying

`render.yaml` describes the web service and its database. Point Render at this
repo, let it read the file, then copy the generated `APP_TOKEN` out of the
dashboard — with it set, every API call must send an `x-book-token` header.

## Where this is going

| Phase | What it adds |
|---|---|
| **1 — Foundation** *(this)* | Database, the entry-and-effects model, opening balances, plain forms over a real book |
| 2 — Entry by sentence | You type "$900 STS chargeuse construction cash"; it reads it back for confirmation before saving |
| 3 — The screens | Accounts and loans on one page, statements with filters, the day report that walks backwards and forwards |
| 4 — Live and on your phone | Login, installed to the home screen, works with no signal, the day report delivered at your cut-off time |
| 5 — Hardening | Audit trail, backups, spreadsheet export, a second user who enters while you approve |

## Layout

```
shared/     types and the engine — no database, no screens, fully tested
server/     Postgres schema, the API, and reading the book in and out
client/     the app
```
