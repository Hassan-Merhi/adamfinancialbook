-- Baseline migration for both fresh installs and databases that predate the migration ledger.
-- Keep this idempotent so an existing Adam Financial Book database can be adopted safely.

CREATE TABLE IF NOT EXISTS businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  opening      NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT '',
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT '',
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('receivable','payable','salary')),
  opening      NUMERIC(14,2) NOT NULL DEFAULT 0,
  salary       NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loans (
  id            TEXT PRIMARY KEY,
  from_business TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  to_business   TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  opening       NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (from_business, to_business)
);

CREATE TABLE IF NOT EXISTS project_receipts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_on  DATE,
  amount       NUMERIC(14,2) NOT NULL,
  in_cash      BOOLEAN NOT NULL DEFAULT true,
  entry_id     TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  occurred_on     DATE NOT NULL,
  kind            TEXT NOT NULL,
  amount          NUMERIC(14,2) NOT NULL,
  purpose         TEXT NOT NULL DEFAULT '',
  raw             TEXT NOT NULL DEFAULT '',
  account_id      TEXT REFERENCES accounts(id),
  to_account_id   TEXT REFERENCES accounts(id),
  project_id      TEXT REFERENCES projects(id),
  person_id       TEXT REFERENCES people(id),
  for_business    TEXT REFERENCES businesses(id),
  historical      BOOLEAN NOT NULL DEFAULT false,
  link_receipt_id TEXT REFERENCES project_receipts(id),
  corrected_from  NUMERIC(14,2),
  client_ref      TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS client_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS entries_client_ref_idx ON entries (client_ref);

CREATE TABLE IF NOT EXISTS effects (
  id            BIGSERIAL PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  target_id     TEXT,
  from_business TEXT,
  to_business   TEXT,
  delta         NUMERIC(14,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_occurred_on_idx ON entries (occurred_on);
CREATE INDEX IF NOT EXISTS effects_entry_idx ON effects (entry_id);
CREATE INDEX IF NOT EXISTS effects_target_idx ON effects (type, target_id);

CREATE TABLE IF NOT EXISTS reminders (
  id          TEXT PRIMARY KEY,
  what        TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_id  TEXT REFERENCES accounts(id),
  note        TEXT NOT NULL DEFAULT '',
  settled     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','entry')),
  language      TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','fr','ar')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_language_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_language_check CHECK (language IN ('en','fr','ar'));
  END IF;
END $$;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS voided      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS created_by  TEXT;

CREATE TABLE IF NOT EXISTS audit (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_accounts (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_accounts_user_idx ON user_accounts (user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  related_type  TEXT,
  related_id    TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_transfers (
  id                 TEXT PRIMARY KEY,
  from_account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  purpose            TEXT NOT NULL DEFAULT 'Cash handoff',
  occurred_on        DATE NOT NULL,
  requested_by       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  confirmed_at       TIMESTAMPTZ,
  entry_id           TEXT REFERENCES entries(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_transfers_recipient_idx
  ON pending_transfers (recipient_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id            TEXT PRIMARY KEY,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  request_text  TEXT NOT NULL,
  amount        NUMERIC(14,2),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note   TEXT NOT NULL DEFAULT '',
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id                   TEXT PRIMARY KEY,
  uploaded_by          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entry_id             TEXT REFERENCES entries(id) ON DELETE CASCADE,
  approval_request_id  TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
  filename             TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  byte_size            INT NOT NULL CHECK (byte_size > 0),
  data                 BYTEA NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((entry_id IS NOT NULL AND approval_request_id IS NULL)
      OR (entry_id IS NULL AND approval_request_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS attachments_entry_idx ON attachments (entry_id);
CREATE INDEX IF NOT EXISTS attachments_approval_idx ON attachments (approval_request_id);
