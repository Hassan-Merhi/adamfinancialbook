-- Keep the overview balance aggregation fast at production scale.
--
-- Current balances aggregate every active effect and join to non-voided entries.
-- The previous target-oriented effect indexes are ideal for focused statements,
-- but do not cover the all-target balance scan (notably loan effects with no
-- target_id). These two partial/covering indexes let PostgreSQL satisfy the
-- balance join and aggregation with substantially less heap I/O while preserving
-- the exact accounting query and its existing performance threshold.

CREATE INDEX IF NOT EXISTS effects_active_balance_cover_idx
  ON effects (entry_id, type, target_id, from_business, to_business)
  INCLUDE (delta)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS entries_nonvoid_balance_join_idx
  ON entries (id, occurred_on)
  WHERE voided = false;
