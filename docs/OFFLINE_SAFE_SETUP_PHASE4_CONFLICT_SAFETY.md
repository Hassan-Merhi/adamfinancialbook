# Offline Safe Setup Phase 4 — Conflict & Financial Safety

Phase 4 makes dependency ordering a single safety contract across replay, projected UI state, and Sync Center status.

- A queued parent setup item is always evaluated before its dependent children, even after restart, timestamp ties, or legacy durable-order recovery.
- If a parent reaches conflict or rejection, that parent and every downstream child stop contributing to the projected offline book.
- Sync status counts descendants behind the blocking parent in the same order used by actual replay.
- Children can never overtake a conflicted/rejected parent, and a parent cannot be discarded while queued children still depend on it.
- The server remains final authority for validation, financial effects, authorization, idempotency, and audit records.
- No database migration or accounting-rule change is introduced by this hardening pass.
