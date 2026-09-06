# Advanced Offline Phase 2 — Projected Ledger & Balances

Phase 2 makes queued offline financial entries visible immediately without treating them as server-confirmed accounting records.

## Confirmed vs projected

IndexedDB continues to store the last server-confirmed book snapshot from Phase 1. The app never writes projected balances back into that snapshot. When the active user has queued entries, the visible book is derived from:

1. the confirmed snapshot, plus
2. that user's ordered IndexedDB outbox.

Removing the queue therefore removes the projection automatically. A later server refresh replaces the confirmed base only after the server accepts synced work.

## Projection rules

Each queued entry is converted into a synthetic ledger row with an `offline:` id and the queue's stable `clientRef`. Its effects come from the same shared `withLoanEffects` accounting engine used by normal entries.

Projected effects update only cloned visible balances:

- account cash
- total cash
- business cash totals
- people/payables/receivables using the product's displayed sign convention
- project receipts
- existing intercompany loan positions

Historical entries keep their existing no-current-cash behavior. Linked project receipts move cash without counting project revenue twice.

## Safety boundaries

Projected values are provisional. They are clearly labeled as pending/unconfirmed in the global sync banner, Today activity, and target statements. Projected rows never expose Correct or Void actions because those require a real server entry id.

The server remains authoritative for permissions, delegated-transfer confirmation, validation, and final posting. A projected transfer can therefore change after sync if the server routes it into a confirmation workflow. Phase 4 adds explicit conflict and financial-safety handling for those cases.

## Durability

The prompt waits for the IndexedDB outbox write to finish before telling the user an offline entry is kept. This prevents the UI from presenting a projected transaction that has not been durably saved on the device.

## Phase boundary

Phase 2 does **not** implement rich sync states, retries beyond the existing outbox behavior, rejection persistence, conflict resolution, offline attachment uploads, or the final reconnect/chaos certification. Those remain Phases 3–7.
