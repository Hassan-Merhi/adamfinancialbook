-- Phase 1 offline revisions: corrections and voids need the same exactly-once
-- replay guarantee as ordinary offline entries. The client reference belongs to
-- the revision event, not to the original financial entry.
ALTER TABLE entry_revisions ADD COLUMN IF NOT EXISTS client_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS entry_revisions_client_ref_idx
  ON entry_revisions (client_ref)
  WHERE client_ref IS NOT NULL;
