# Working on this repo

A money tracker for several businesses. Read `README.md` first — the "one idea"
section is not decoration, it is the constraint the whole codebase is built on.

## Rules that must not be broken

1. **Balances are never stored.** A balance is an opening figure plus every
   effect. If you find yourself writing an `UPDATE ... SET balance`, stop.
2. **One event, one entry, many effects.** Never write two entries to express
   one thing that happened.
3. **Loan direction is computed, never taken from input.** Money leaving A for B
   reduces "A owes B". `withLoanEffects` is the only place that decides this.
4. **Signs are from the owner's side.** Minus means he owes it, plus means it is
   owed to him. Applies to people, suppliers, payroll and loan positions alike.
5. **Corrections replace.** Reverse the old effects, write new ones, keep
   `correctedFrom`.

6. **A reader never saves.** `shared/parse.ts` and `server/read.ts` both return a
   draft for a person to confirm. Neither writes to the book, and neither may
   return an id that is not in the catalog.

7. **Nothing behind `/api` is open.** Every route needs a session; the ones that
   reshape the book or edit history need the `owner` role. A state-changing call
   must also carry `x-book: 1`, which a cross-site form cannot send.
8. **Only entries are queued offline.** Setting the book up and correcting an
   entry need the server there and then. Anything queued carries a `clientRef`
   so it cannot be logged twice.

9. **Nothing is deleted.** A wrong entry is voided: `voided = true`, the reason
   kept, and `ordered()` leaves it out of every figure. Never write a DELETE
   against entries or effects except when rewriting one entry's own effects.
10. **Every change leaves a line.** Anything that shapes the book or edits
    history calls `record(req, …)`. A failed audit write must never fail the
    thing the user asked for.

## Layout

- `shared/` — types, the engine, and the rules reader. Pure functions, no
  database, no React. Every money rule lives here and every one has a test.
- `server/` — Postgres schema, the API, loading and saving the book.
- `client/` — the app. `views/` is one file per screen, `ui.tsx` holds the
  pieces they share, `Entry.tsx` is the box and the confirmation card. The look
  is CSS tokens only; changing the palette or the fonts must never require
  touching a screen.

Balances shown on screen come from `book.balances` (worked out server-side for
today) or from calling the engine with a date (any past day). Never add a
figure to the client that the engine cannot also produce for a past date.

## Before pushing

```bash
npm test && npm run typecheck && npm run build
```

New money behaviour needs a test in `shared/engine.test.ts` alongside it.
