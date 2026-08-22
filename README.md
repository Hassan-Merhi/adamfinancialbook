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

## The look

Two looks, switched live from the buttons at the bottom right — **Assistant**
(flat, Inter, generous corners) and **Ledger** (a dark rail, Archivo and IBM
Plex Mono, tighter corners) — plus a light/dark switch. On a phone the same two
switches sit at the bottom of the Today screen. Your choice is remembered.

A look is a block of CSS custom properties: colours, three typefaces, two corner
radii. No screen and no figure knows which one is on, which is why switching is
instant and a new one is an afternoon rather than a rebuild.

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
| The same entry cannot land twice, however many times it is sent | `clientRef` + `entries_client_ref_idx` |
| An entry is voided, never deleted — it stops counting and says why | `voidEntry`, `ordered()` |
| Every change to the book leaves a line saying who and when | `server/audit.ts` |

Every one of these has a test in `shared/engine.test.ts`.

## Who can open it

Nothing behind `/api` opens without a session, and nobody can let themselves in.
The first time you load an empty book it asks you to choose the email and
password you will use; after that the door is closed for good.

Everything else happens on the **Access** screen:

- **Your password** — change it whenever you like. Every other session you had
  open, on any device, is signed out the moment you do.
- **Who can open the book** — everyone with a key, when each of them last used
  it, and what they may do. Open a row to set them a new password, change what
  they may do, or take their access away, which signs them out at once.
- **Give someone access** — an email, a role and a first password (there is a
  Suggest button for one that can be read down the phone). The password is shown
  once, for you to pass on; they change it themselves on the same screen.

Two roles. **owner** does everything. **entry** can only log entries and read
them back — no setting the book up, no corrections, no access screen beyond
their own password — so someone can type while you approve.

The book can never be left without an owner: the last one cannot be demoted or
removed, and nobody can remove themselves. `npm run user:add` still works from
the command line if you are ever locked out.

## On your phone

Open it in Safari or Chrome and add it to the home screen: it installs as an
app, opens full screen, and works with no signal.

The phone layout puts your thumb first: the name and the cash figure along the
top, the views scrolling in the middle, the box you type in just above a row of
tabs at the bottom. The confirmation card opens as a sheet over the views, with
**Log it** pinned where you can always reach it.

With no network it opens on the figures from the last time it loaded, says so
plainly, and reads your sentences locally instead of asking the server. Anything
you log waits in an outbox and is sent, oldest first, the moment there is a
network. Every entry carries a reference the app made, so the same one can never
land twice — not from a retry, not from two tabs, not from the network coming
back twice at once.

Setting the book up and correcting an entry are not queued: they need the server
there and then, and say so rather than pretending.

## When something goes wrong

An entry is never deleted. A wrong one is **voided**: it stops counting the
moment you void it, keeps its place, and carries the reason you gave. Correcting
an amount still replaces the entry and keeps the original figure visible.

**History** shows every change to the book — who did it, when, and what it was —
written beside the book and never edited. Sign-ins and refused sign-ins are on it
too.

## Taking it with you

- **Entries as a spreadsheet** — a CSV with names rather than ids, safe to open
  anywhere: a comma or a quote stays inside its cell, and a purpose beginning
  with `=` cannot act as a formula.
- **Whole book, as a backup** — every table, exactly as stored, so the book can
  be rebuilt from it. `npm run backup` writes the same file from the command
  line, and Render keeps its own database backups besides.

## The day report, delivered

`npm run report:send` writes the day in plain words and emails it. With no
`SMTP_URL` / `REPORT_TO` set it prints the report instead, so the schedule can be
proved before any account is connected. `render.yaml` runs it daily at your
cut-off time (17:00 UTC = 19:00 in Lubumbashi).

## Running it

```bash
npm install
cp .env.example .env      # then set DATABASE_URL and SESSION_SECRET
npm run db:setup          # creates the tables (safe to re-run)
npm run dev               # API on :5000, app on :5173
```

```bash
npm test         # the money rules
npm run typecheck
npm run build
```

## Where the database lives

The book keeps its data on **Neon** and runs on **Render**. Neon's free database
is not deleted after thirty days the way Render's free one is, which is the only
reason for the split.

1. **neon.tech** → new project. Pick the region nearest you — from Lubumbashi
   that is Frankfurt (`aws-eu-central-1`).
2. Copy the **pooled** connection string (its host contains `-pooler`). It ends
   in `?sslmode=require`; leave that on.
3. Create the tables once, from your own machine:
   ```bash
   echo 'DATABASE_URL=<the string you copied>' > .env
   echo 'SESSION_SECRET=anything-long-for-now' >> .env
   npm run db:setup
   ```
4. Paste the same string into `DATABASE_URL` on both Render services.

Pick the **Frankfurt** region on Render too. The app talks to the database on
every request, and a book whose database is on another continent feels slow for
no reason.

The connection is encrypted and the certificate is verified. If the socket turns
out not to be speaking TLS, the app refuses to start rather than sending your
figures across the internet in the clear. `PGSSL=off` is for a Postgres on your
own machine.

Neon's pooled endpoint terminates TLS at the pooler, so the server's own
`pg_stat_ssl` reads false there even though the connection from here is
encrypted. The check looks at this process's socket instead, which is the honest
answer for the hop that crosses the internet.

## Deploying

On Render: **New → Blueprint → pick this repo → Apply**. It reads `render.yaml`
and creates the app and the nightly report job. `SESSION_SECRET` is generated
for you; paste your Neon `DATABASE_URL` into both. Set `REPORT_TO` and `SMTP_URL` when you want the report to
arrive rather than just print, and `ANTHROPIC_API_KEY` if you want Claude to read
the sentences.

Then open the site and choose your email and password: the first owner is
created once, on an empty book.

## Where this is going

| Phase | What it adds |
|---|---|
| 1 — Foundation ✅ | Database, the entry-and-effects model, opening balances, plain forms over a real book |
| 2 — Entry by sentence ✅ | You type it the way you say it; the reading comes back for confirmation, with every consequence shown, before it is saved |
| 3 — The screens ✅ | Accounts and loans on one page, statements with filters, the day report that walks backwards and forwards, on desktop and phone |
| 4 — Live and on your phone ✅ | Login with two roles, installed to the home screen, works with no signal, the day report delivered at your cut-off time |
| **5 — Hardening ✅** *(this)* | Voiding rather than deleting, a full audit trail, spreadsheet export and backups, a door that resists guessing |

All five are built. What remains is the part only you can do: use it for a
fortnight and tell me what gets in the way.

## Layout

```
shared/     types, the engine, the rules reader — no database, no screens, tested
server/     Postgres schema, the API, the Claude reader, reading the book in and out
client/     the app — views/ is one file per screen, ui.tsx the pieces they share
```
