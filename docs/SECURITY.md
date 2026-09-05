# Security model

Adam Financial Book treats identity records as part of the accounting history. A user who has posted entries, approved requests or confirmed transfers is never physically removed from PostgreSQL. Owners disable access instead; the user row and historical foreign-key relationships remain intact.

## User lifecycle

- `users.active` controls whether a person may authenticate.
- Disabling access records `disabled_at` and `disabled_by`, revokes every active session, removes current delegated-account assignments and rejects still-pending cash handoffs addressed to that user.
- Restoring a user re-enables authentication but intentionally does not silently restore old account assignments.
- A database trigger rejects physical `DELETE FROM users` operations.
- A second database trigger rejects disabling or demoting the final active owner, even if an API check is bypassed.
- Delegated account assignments are database-validated: the target must be an active `entry` user.

## Passwords and authentication

Passwords use salted scrypt hashes. New passwords require at least 12 characters. Passwords shorter than 18 characters must include at least three of lowercase letters, uppercase letters, numbers and symbols; long passphrases are accepted.

Login failures are tracked in PostgreSQL rather than process memory. Eight failures in a 15-minute window lock that IP/email pair for 15 minutes, so a process restart does not reset the lock. Responses do not reveal whether the account exists. A lock event is written to the audit trail and creates a security notification for active owners.

## Sessions

Every new login creates a row in `user_sessions` and the signed HttpOnly cookie contains that persistent session ID. Older signed cookies from before Phase 6 are accepted once and transparently upgraded to a tracked session.

- owner session lifetime: 7 days
- entry-only session lifetime: 24 hours
- changing a password revokes all old sessions
- changing a role revokes old sessions so privileges change immediately
- disabling a user revokes all sessions immediately
- the Access screen lists signed-in devices and allows revoking one session or every session

Only a SHA-256 hash of the client IP is retained with the session metadata; raw IP addresses are not stored in the session table.

## Sensitive-action reauthentication

Creating users, changing another user's password or role, disabling/restoring access, changing delegated-account assignments, and configuring MFA require a recently authenticated session. The owner unlocks these actions with the current password (and authenticator code when MFA is enabled). The unlock window is 10 minutes.

## Owner authenticator MFA

Owners can enable standards-compatible six-digit TOTP authentication from Access → Security. The setup secret works with common authenticator applications that support `otpauth://` TOTP accounts.

TOTP secrets are encrypted before storage using AES-256-GCM. Set a stable `MFA_ENCRYPTION_KEY` in production before enabling MFA. If it is omitted, `SESSION_SECRET` is used. Do not rotate the encryption key without a planned MFA reset process: existing encrypted authenticator secrets depend on it.

Enabling or disabling MFA revokes the owner's other active sessions. Once MFA is enabled, both normal sign-in and security reauthentication require a valid authenticator code.

## Security events and auditing

The audit log records sign-in failures/locks, successful sign-ins, security reauthentication, access disable/restore actions, password and role changes, MFA setup/enable/disable, and session revocation. Security-sensitive notifications are sent to active owners for lockouts and major MFA/access changes.

## Test coverage

`npm run test:integration` runs the accounting PostgreSQL suite and the Phase 6 security PostgreSQL suite sequentially. The security suite verifies migration 005, durable rate limiting across an API restart, role-specific session lifetimes, reauthentication gates, database owner/assignment protections, soft-disable history preservation, delegated API isolation, session revocation, and live TOTP sign-in/reauthentication behavior.
