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

## Layout

- `shared/` — types and the engine. Pure functions, no database, no React.
  Every money rule lives here and every one of them has a test.
- `server/` — Postgres schema, the API, loading and saving the book.
- `client/` — the app. The look is CSS tokens only; changing the palette or the
  fonts must never require touching a screen.

## Before pushing

```bash
npm test && npm run typecheck && npm run build
```

New money behaviour needs a test in `shared/engine.test.ts` alongside it.
