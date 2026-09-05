-- Phase 7: indexes for focused reads, pagination, search and SQL aggregation.
-- Every index is additive/idempotent so existing deployments can adopt it safely.

CREATE INDEX IF NOT EXISTS entries_active_recent_idx
  ON entries (occurred_on DESC, created_at DESC, id DESC)
  WHERE voided = false;

CREATE INDEX IF NOT EXISTS entries_active_account_idx
  ON entries (account_id, occurred_on DESC, created_at DESC, id DESC)
  WHERE voided = false AND account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_active_to_account_idx
  ON entries (to_account_id, occurred_on DESC, created_at DESC, id DESC)
  WHERE voided = false AND to_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_active_person_idx
  ON entries (person_id, occurred_on DESC, created_at DESC, id DESC)
  WHERE voided = false AND person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_active_project_idx
  ON entries (project_id, occurred_on DESC, created_at DESC, id DESC)
  WHERE voided = false AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_created_by_recent_idx
  ON entries (created_by, created_at DESC, id DESC)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_search_idx
  ON entries USING GIN (to_tsvector('simple', COALESCE(purpose,'') || ' ' || COALESCE(raw,'')));

CREATE INDEX IF NOT EXISTS effects_active_target_entry_idx
  ON effects (type, target_id, entry_id)
  WHERE active = true AND target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS effects_active_loan_entry_idx
  ON effects (from_business, to_business, entry_id)
  WHERE active = true AND type = 'loan';

CREATE INDEX IF NOT EXISTS project_receipts_active_project_idx
  ON project_receipts (project_id, occurred_on, id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_open_recent_idx
  ON reminders (created_at DESC, id)
  WHERE settled = false;

CREATE INDEX IF NOT EXISTS notifications_unread_user_idx
  ON notifications (user_id, created_at DESC, id)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS pending_transfers_pending_recent_idx
  ON pending_transfers (created_at DESC, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS approval_requests_creator_recent_idx
  ON approval_requests (created_by, created_at DESC, id);

CREATE INDEX IF NOT EXISTS attachments_created_recent_idx
  ON attachments (created_at DESC, id);
