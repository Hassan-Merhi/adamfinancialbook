-- A confirmed delegated handoff can later be voided by the owner from the
-- statement. Preserve that historical state explicitly instead of leaving a
-- confirmed handoff pointing at a voided ledger entry.

ALTER TABLE pending_transfers
  DROP CONSTRAINT IF EXISTS pending_transfers_status_check;

ALTER TABLE pending_transfers
  ADD CONSTRAINT pending_transfers_status_check
  CHECK (status IN ('pending','confirmed','rejected','voided'));
