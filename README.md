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

## Saying what happened

You type the way you would say it, and the reading comes back for confirmation
before anything is kept:

```
$900 STS chargeuse construction cash
$250 filming for the bikes from construction cash
$25000 withdrawn from Soficom into construction cash
i bought 1 ton of steel from Dani
$50000 collected from Kin Severe
add supplier Somika Plumbing under Construction
```

The same box sets the book up — a business, an account with its opening balance,
a project, a payroll worker, a supplier — and whatever it creates is part of the
vocabulary immediately.

Two readers, one shape. `shared/parse.ts` works with no key, no network and no
cost. With `ANTHROPIC_API_KEY` set, `server/read.ts` asks Claude instead, giving
it the book's own vocabulary; it falls back to the rules reader if anything goes
wrong. Neither one saves: both return a draft, and every id they return is
checked against the catalog before it is shown.

## The screens

- **Today** — cash on hand, what is owed to you and what you owe, cash by
  business, and everything entered today.
- **Accounts & loans** — one page, because a business's cash and its
  obligations are read together. Minus is money it must return, plus is money
  it is waiting on.
- **Projects** — what each job has paid, and which receipts have not reached an
  account yet.
- **People** — three lists that never mix: they owe you, payroll, suppliers.
- **Day report** — any day rebuilt exactly as it stood: cash at the end of that
  day, what came in, what went out, what was taken on credit, what merely moved,
  and what was outstanding *then*. Walk backwards and forwards a day at a time,
  filtered to one business or all of them.

Every figure opens into the entries behind it: a statement with a running
balance, filters by text, type and date range, and a Correct button on each row.
One codebase serves the desktop and the phone.

## Rules the code enforces

| Rule | Where |
|---|---|
| Money leaving A for B always **reduces** "A owes B" — the direction is computed, never typed | `shared/engine.ts` → `withLoanEffects` |
| Goods taken on credit change what you owe, never what you have: no account is touched | `computeEffects`, `credit_purchase` |
| Minus means you owe it, plus means it is owed to you — one reading everywhere | `personBalance`, `loanFrom` |
| A receipt already recorded, only now arriving, moves cash and nothing else | `possibleDuplicateReceipt`, `receipt_banked` |
| A historical line updates the past and leaves today's cash alone | `historical` on an entry |
| A person's loan, their salary and their invoices stay in three separate columns | `PersonKind` |
| An account is never assumed silently — a guessed one is flagged on the card | `parse.ts` → `guessed` |
| A count is not a price: "1 ton of bricks" asks for the amount | `parse.ts` → `readAmount` |

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
| 1 — Foundation ✅ | Database, the entry-and-effects model, opening balances, plain forms over a real book |
| 2 — Entry by sentence ✅ | You type it the way you say it; the reading comes back for confirmation, with every consequence shown, before it is saved |
| **3 — The screens ✅** *(this)* | Accounts and loans on one page, statements with filters, the day report that walks backwards and forwards, on desktop and phone |
| 4 — Live and on your phone | Login, installed to the home screen, works with no signal, the day report delivered at your cut-off time |
| 5 — Hardening | Audit trail, backups, spreadsheet export, a second user who enters while you approve |

## Layout

```
shared/     types, the engine, the rules reader — no database, no screens, tested
server/     Postgres schema, the API, the Claude reader, reading the book in and out
client/     the app — views/ is one file per screen, ui.tsx the pieces they share
```
