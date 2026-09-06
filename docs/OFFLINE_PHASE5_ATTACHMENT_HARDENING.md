# Offline Phase 5 — Attachment & Receipt Hardening

Phase 5 makes offline evidence lifecycle-safe around the newer financial outbox.

- Receipts remain user-scoped and are re-checked against the active signed-in user immediately before upload.
- A sign-out/sign-in switch pauses the old user's receipt queue instead of allowing it to continue under the new session.
- Discarding an unsynced financial entry also removes its unsynced local receipt blobs, preventing permanent orphan evidence.
- The 20-receipt limit is enforced across repeated local queue operations and again on the server before insert.
- Stable attachment IDs retain exactly-once replay semantics after uncertain network failures.
- Uploaded evidence remains server-authoritative and audited; client cleanup never deletes server evidence.
- No accounting-rule or database-schema migration is required.
