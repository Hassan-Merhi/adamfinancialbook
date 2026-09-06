-- Allow an owner to permanently remove a disabled login while preserving the
-- financial records that user may have created, reviewed, requested, or uploaded.
--
-- Phase 6 originally treated users as undeletable historical principals. The
-- product now supports a two-step lifecycle instead: disable first, then delete.
-- Historical/accounting rows keep their data and nullable user references are
-- cleared; ephemeral access/session rows can disappear with the deleted login.

DROP TRIGGER IF EXISTS users_no_delete ON users;
DROP FUNCTION IF EXISTS prevent_physical_user_delete();

-- Physical deletion remains database-guarded. Only an application transaction
-- that explicitly opts in with app.allow_user_delete=true may delete a user.
-- This preserves the direct-SQL safety boundary while allowing the owner's
-- disable-then-delete workflow and Factory Reset to work.
CREATE OR REPLACE FUNCTION guard_user_physical_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  other_owners INT;
BEGIN
  IF current_setting('app.allow_user_delete', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Users cannot be deleted directly; disable access and use the permanent-delete action.';
  END IF;

  IF OLD.active = true AND OLD.role = 'owner' THEN
    SELECT count(*)::int INTO other_owners
      FROM users
     WHERE id <> OLD.id AND active = true AND role = 'owner';
    IF other_owners = 0 THEN
      RAISE EXCEPTION 'The last active owner cannot be deleted.';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS users_guard_delete ON users;
CREATE TRIGGER users_guard_delete
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION guard_user_physical_delete();

-- Sessions have no accounting value. Once the login is permanently deleted,
-- remove its session rows as well.
ALTER TABLE user_sessions
  DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;
ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Keep transfer history even after either participating login is deleted.
ALTER TABLE pending_transfers
  ALTER COLUMN requested_by DROP NOT NULL,
  ALTER COLUMN recipient_user_id DROP NOT NULL;
ALTER TABLE pending_transfers
  DROP CONSTRAINT IF EXISTS pending_transfers_requested_by_fkey,
  DROP CONSTRAINT IF EXISTS pending_transfers_recipient_user_id_fkey;
ALTER TABLE pending_transfers
  ADD CONSTRAINT pending_transfers_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT pending_transfers_recipient_user_id_fkey
    FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Approval records are evidence and must not be cascaded away with the login.
ALTER TABLE approval_requests
  ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_created_by_fkey;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- Receipt/evidence files also survive account deletion.
ALTER TABLE attachments
  ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE attachments
  DROP CONSTRAINT IF EXISTS attachments_uploaded_by_fkey;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
