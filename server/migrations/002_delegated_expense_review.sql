-- Owner-side classification for expenses entered by delegated users.
-- Cash is already posted when the delegated user confirms the expense; these
-- fields only track the later owner review and classification.

ALTER TABLE entries ADD COLUMN IF NOT EXISTS review_category TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS entries_delegated_review_idx
  ON entries (created_at DESC)
  WHERE kind = 'expense' AND reviewed_at IS NULL AND voided = false;
