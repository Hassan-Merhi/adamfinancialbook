# P2 Final UI and 99/100 Release Gate

P2 is the final presentation/accessibility cleanup and release closeout after P0/P1 hardening. It does not change accounting rules, permissions, offline write semantics, migrations, or API contracts.

## UI consistency

P2 standardizes the shared visual language across daily, secondary, setup, and access screens:

- consistent control heights and touch targets
- shared card/note radii and spacing rhythm
- explicit destructive-action treatment
- mobile drawer viewport/safe-area containment
- long translated/account/project/file labels may wrap instead of clipping
- reduced-motion and forced-colors behavior remains explicit
- empty states are semantic status regions
- shared row actions use explicit `type="button"` and decorative chevrons are hidden from screen readers

## Screen-reader form naming

Legacy `.f` form groups frequently render visible labels without an explicit native association. `client/src/form-a11y.ts` adds a programmatic accessible name only when the field has no existing `aria-label`, `aria-labelledby`, or native `label[for]` association. Explicit component accessibility always wins. A MutationObserver covers lazy-loaded and conditional views.

## Permanent browser gate

`npm run test:p2-ui` runs after the P1 WebKit mobile certification in CI. It checks 320x568, 393x852, and 430x932 touch/mobile viewports for:

- primary prompt immediately visible
- all primary and More pages open without horizontal overflow
- core controls maintain phone-sized touch targets
- visible inputs/selects/textareas have accessible names
- Access and Setup remain one-section-at-a-time mobile navigation
- reset/destructive actions remain visually distinct
- More drawer stays within the viewport
- dark-mode layout remains stable
- no unhandled WebKit page errors

## Final release rule

The 99/100 release can be tagged only after the final `main` SHA has all of the following evidence:

1. typecheck, unit/regression tests, and production build green
2. integration, offline chaos/multi-device, financial reconciliation, and final DB integrity green
3. production-scale load certification green
4. P1 WebKit mobile/PWA certification green
5. P2 WebKit UI/accessibility certification green
6. dependency/secret audit green
7. CodeQL high/critical gate green
8. exact Render SHA live and production deploy certification green
9. fresh encrypted production backup delivered off-site and acknowledged
10. disaster-recovery restore path remains covered by the recovery integration suite and P0 restore validation
11. no known open accounting correctness blocker
12. stable release tag created from the certified final SHA

There is no P2 production database migration and no manual TablePlus SQL requirement.
