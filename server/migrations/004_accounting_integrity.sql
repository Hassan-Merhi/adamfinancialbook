-- Phase 5: make every accounting mutation reconstructible and cross-table safe.
-- Existing legacy rows are adopted without rewriting their economic meaning.

ALTER TABLE entries ADD COLUMN IF NOT EXISTS transaction_id TEXT;
UPDATE entries SET transaction_id = 'legacy:' || id WHERE transaction_id IS NULL;
ALTER TABLE entries ALTER COLUMN transaction_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entries_transaction_id_idx ON entries (transaction_id);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS correction_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS voided_by TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE effects ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE effects ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE effects ADD COLUMN IF NOT EXISTS superseded_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS effects_active_entry_idx ON effects (entry_id, active);

ALTER TABLE project_receipts ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE project_receipts ADD COLUMN IF NOT EXISTS voided_by TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE audit ADD COLUMN IF NOT EXISTS transaction_id TEXT;
CREATE INDEX IF NOT EXISTS audit_transaction_idx ON audit (transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entry_revisions (
  id              BIGSERIAL PRIMARY KEY,
  entry_id        TEXT NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
  transaction_id  TEXT NOT NULL UNIQUE,
  revision_type   TEXT NOT NULL CHECK (revision_type IN ('correction','classification','void')),
  actor_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email     TEXT,
  reason          TEXT NOT NULL DEFAULT '',
  before_entry    JSONB NOT NULL,
  before_effects  JSONB NOT NULL,
  after_entry     JSONB NOT NULL,
  after_effects   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entry_revisions_entry_idx ON entry_revisions (entry_id, created_at, id);

-- New/changed rows must obey the ledger's invariants. NOT VALID deliberately
-- allows a legacy database to come online first; the integrity checker reports
-- any pre-existing bad rows instead of making the deployment unrecoverable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entries_amount_positive' AND conrelid = 'entries'::regclass
  ) THEN
    ALTER TABLE entries ADD CONSTRAINT entries_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entries_kind_known' AND conrelid = 'entries'::regclass
  ) THEN
    ALTER TABLE entries ADD CONSTRAINT entries_kind_known
      CHECK (kind IN ('expense','credit_purchase','receipt','transfer','person_loan','salary','supplier_payment')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entries_transfer_shape' AND conrelid = 'entries'::regclass
  ) THEN
    ALTER TABLE entries ADD CONSTRAINT entries_transfer_shape
      CHECK (kind <> 'transfer' OR (
        account_id IS NOT NULL AND to_account_id IS NOT NULL AND account_id <> to_account_id
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'effects_type_known' AND conrelid = 'effects'::regclass
  ) THEN
    ALTER TABLE effects ADD CONSTRAINT effects_type_known
      CHECK (type IN ('account','project','person','loan','cost','receipt_banked')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'effects_shape_valid' AND conrelid = 'effects'::regclass
  ) THEN
    ALTER TABLE effects ADD CONSTRAINT effects_shape_valid CHECK (
      (type = 'loan' AND from_business IS NOT NULL AND to_business IS NOT NULL AND from_business <> to_business)
      OR
      (type <> 'loan' AND target_id IS NOT NULL)
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_receipts_entry_fk' AND conrelid = 'project_receipts'::regclass
  ) THEN
    ALTER TABLE project_receipts
      ADD CONSTRAINT project_receipts_entry_fk
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

-- A delegated cash handoff becomes confirmed in the exact transaction that
-- creates its transfer entry. This closes the old failure window where the
-- entry could commit but the pending-transfer status update could fail later.
CREATE OR REPLACE FUNCTION confirm_handoff_with_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  handoff_id TEXT;
BEGIN
  IF NEW.kind = 'transfer' AND NEW.client_ref LIKE 'handoff\_%' ESCAPE '\\' THEN
    handoff_id := substring(NEW.client_ref FROM 9);

    UPDATE pending_transfers
       SET status = 'confirmed',
           confirmed_at = COALESCE(confirmed_at, now()),
           entry_id = NEW.id
     WHERE id = handoff_id
       AND status = 'pending'
       AND from_account_id = NEW.account_id
       AND to_account_id = NEW.to_account_id
       AND amount = NEW.amount;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Handoff entry does not match one pending transfer: %', handoff_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entries_confirm_handoff ON entries;
CREATE TRIGGER entries_confirm_handoff
AFTER INSERT ON entries
FOR EACH ROW EXECUTE FUNCTION confirm_handoff_with_entry();
