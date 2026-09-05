-- Phase 8: durable translation cache for dynamic user-entered text.
-- Static interface copy lives in reviewed client catalogs and never needs this table.

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
