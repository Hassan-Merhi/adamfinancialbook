-- The book, as tables. Balances are never stored: they are the opening figure
-- plus every effect, which is why any past date can be rebuilt exactly.

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

-- kind: 'receivable' (owes you) | 'payable' (supplier) | 'salary' (payroll)
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

-- One row per pair. `opening` reads as "from owes to"; negative runs the other way.
CREATE TABLE IF NOT EXISTS loans (
  id            TEXT PRIMARY KEY,
  from_business TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  to_business   TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  opening       NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (from_business, to_business)
);

-- A client payment, counted once on the day the job pays. Rows with a null
-- entry_id are history recorded at the cut-off.
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

-- Every consequence of an entry, written with it and rewritten on a correction.
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

-- "Will pay $11,550 transport from the bank" is a promise, not a movement.
-- Reminders sit beside the book and never touch a balance.
CREATE TABLE IF NOT EXISTS reminders (
  id          TEXT PRIMARY KEY,
  what        TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_id  TEXT REFERENCES accounts(id),
  note        TEXT NOT NULL DEFAULT '',
  settled     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who may open the book. 'owner' can do everything; 'entry' can only add
-- entries and read them back, so someone can type while you approve.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','entry')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An entry is never deleted. A wrong one is voided: it stops counting, keeps
-- its place, and says why.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS voided      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS created_by  TEXT;

-- Who did what, and when. Written beside the book, never edited.
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

-- Moves whenever a password changes, which stops every session issued before it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
