-- Phase 7: accelerate the hottest current-balance aggregation without changing accounting semantics.
-- The active-effects rollup powers the owner overview and groups by these four columns.
-- INCLUDE(delta) lets PostgreSQL satisfy the SUM from the index when visibility permits an index-only scan.

CREATE INDEX IF NOT EXISTS effects_active_balance_rollup_idx
  ON effects (type, target_id, from_business, to_business)
  INCLUDE (delta)
  WHERE active = true;
