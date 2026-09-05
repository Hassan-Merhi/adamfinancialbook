-- Phase 9 consolidates operational state into the managed schema so a fresh
-- restore target has every table needed before data is replayed.
CREATE TABLE IF NOT EXISTS translation_cache (
  language        TEXT NOT NULL CHECK (language IN ('en','fr','ar')),
  source_language TEXT CHECK (source_language IS NULL OR source_language IN ('en','fr','ar')),
  source_hash     TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'google',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (language, source_hash)
);

CREATE INDEX IF NOT EXISTS translation_cache_updated_idx
  ON translation_cache (updated_at DESC);

CREATE TABLE IF NOT EXISTS backup_runs (
  id                TEXT PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  destination       TEXT NOT NULL,
  bytes             BIGINT,
  checksum          CHAR(64),
  migration_version BIGINT,
  encrypted         BOOLEAN NOT NULL DEFAULT true,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS backup_runs_started_idx
  ON backup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_status_idx
  ON backup_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS operational_events (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity    TEXT NOT NULL CHECK (severity IN ('info','warn','error','critical')),
  event       TEXT NOT NULL,
  request_id  TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS operational_events_created_idx
  ON operational_events (created_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_event_idx
  ON operational_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_severity_idx
  ON operational_events (severity, created_at DESC);
