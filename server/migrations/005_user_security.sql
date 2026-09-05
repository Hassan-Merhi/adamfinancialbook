-- Phase 6: durable user lifecycle, session controls, MFA state, and persistent login throttling.

ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_active_role_idx ON users (active, role);

CREATE TABLE IF NOT EXISTS user_sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_version      INT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  authenticated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revoked_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  ip_hash            CHAR(64),
  user_agent         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx
  ON user_sessions (user_id, revoked_at, expires_at DESC);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx
  ON user_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash           CHAR(64) PRIMARY KEY,
  failure_count      INT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_throttle_locked_idx
  ON login_throttle (locked_until) WHERE locked_until IS NOT NULL;

-- Users are historical principals. Access is revoked by disabling the row, never
-- by deleting it, so entries, approvals, transfers, evidence and audit records
-- can always retain their original actor/user relationships.
CREATE OR REPLACE FUNCTION prevent_physical_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Users are historical records and cannot be deleted; disable access instead.';
END;
$$;

DROP TRIGGER IF EXISTS users_no_delete ON users;
CREATE TRIGGER users_no_delete
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION prevent_physical_user_delete();

-- Enforce the last-owner rule in PostgreSQL as well as the API. This protects
-- against accidental direct SQL edits leaving the book with no active owner.
CREATE OR REPLACE FUNCTION protect_last_active_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  other_owners INT;
BEGIN
  IF OLD.active = true AND OLD.role = 'owner'
     AND (NEW.active = false OR NEW.role <> 'owner') THEN
    SELECT count(*)::int INTO other_owners
      FROM users
     WHERE id <> OLD.id AND active = true AND role = 'owner';
    IF other_owners = 0 THEN
      RAISE EXCEPTION 'Cannot disable or demote the last active owner.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_protect_last_owner ON users;
CREATE TRIGGER users_protect_last_owner
BEFORE UPDATE OF active, role ON users
FOR EACH ROW EXECUTE FUNCTION protect_last_active_owner();

-- Delegated accounts can only belong to an active entry-only user. Keeping this
-- rule in the database prevents a direct API or SQL path from bypassing the UI.
CREATE OR REPLACE FUNCTION validate_user_account_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_role TEXT;
  target_active BOOLEAN;
BEGIN
  SELECT role, active INTO target_role, target_active FROM users WHERE id = NEW.user_id;
  IF target_role IS NULL OR target_role <> 'entry' OR target_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Delegated accounts require an active entry-only user.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_accounts_validate_user ON user_accounts;
CREATE TRIGGER user_accounts_validate_user
BEFORE INSERT OR UPDATE OF user_id ON user_accounts
FOR EACH ROW EXECUTE FUNCTION validate_user_account_assignment();
