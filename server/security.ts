import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { pool, query } from './db.js';

export type SecurityRole = 'owner' | 'entry';

const ENTRY_SESSION_SECONDS = 24 * 60 * 60;
const OWNER_SESSION_SECONDS = 7 * 24 * 60 * 60;
export const RECENT_AUTH_SECONDS = 10 * 60;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_LOCK_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 8;

export function sessionSeconds(role: SecurityRole): number {
  return role === 'owner' ? OWNER_SESSION_SECONDS : ENTRY_SESSION_SECONDS;
}

function sessionId(): string {
  return `sid_${randomBytes(24).toString('base64url')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanAgent(value: string | undefined): string {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 240);
}

export interface CreatedSecuritySession {
  id: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}

export interface SecuritySession {
  id: string;
  userId: string;
  tokenVersion: number;
  createdAt: Date;
  authenticatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string;
}

export async function createSecuritySession(input: {
  userId: string;
  tokenVersion: number;
  role: SecurityRole;
  ip?: string;
  userAgent?: string;
}): Promise<CreatedSecuritySession> {
  const id = sessionId();
  const maxAgeSeconds = sessionSeconds(input.role);
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000);
  await query(
    `INSERT INTO user_sessions
      (id, user_id, token_version, expires_at, ip_hash, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      input.userId,
      input.tokenVersion,
      expiresAt,
      input.ip ? sha256(input.ip) : null,
      cleanAgent(input.userAgent),
    ],
  );
  return { id, expiresAt, maxAgeSeconds };
}

export async function validateSecuritySession(
  id: string,
  userId: string,
  tokenVersion: number,
): Promise<SecuritySession | null> {
  const rows = await query<any>(
    `SELECT id, user_id, token_version, created_at, authenticated_at, last_seen_at,
            expires_at, revoked_at, user_agent
       FROM user_sessions
      WHERE id = $1 AND user_id = $2 AND token_version = $3
        AND revoked_at IS NULL AND expires_at > now()`,
    [id, userId, tokenVersion],
  );
  const row = rows[0];
  if (!row) return null;

  await query(
    `UPDATE user_sessions SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`,
    [id],
  );

  return {
    id: row.id,
    userId: row.user_id,
    tokenVersion: Number(row.token_version),
    createdAt: new Date(row.created_at),
    authenticatedAt: new Date(row.authenticated_at),
    lastSeenAt: new Date(row.last_seen_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    userAgent: row.user_agent ?? '',
  };
}

export async function listSecuritySessions(userId: string, currentId?: string | null) {
  const rows = await query<any>(
    `SELECT id, created_at, authenticated_at, last_seen_at, expires_at, revoked_at, user_agent
       FROM user_sessions
      WHERE user_id = $1 AND expires_at > now() - interval '30 days'
      ORDER BY revoked_at NULLS FIRST, last_seen_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentId,
    createdAt: new Date(row.created_at).toISOString(),
    authenticatedAt: new Date(row.authenticated_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    userAgent: row.user_agent || 'Unknown device',
  }));
}

export async function markSessionReauthenticated(sessionIdValue: string): Promise<void> {
  const rows = await query(
    `UPDATE user_sessions SET authenticated_at = now(), last_seen_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`,
    [sessionIdValue],
  );
  if (!rows[0]) throw Object.assign(new Error('This session is no longer active.'), { status: 401 });
}

export async function hasRecentAuthentication(sessionIdValue?: string | null): Promise<boolean> {
  if (!sessionIdValue) return false;
  const rows = await query<{ ok: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM user_sessions
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND authenticated_at > now() - ($2::int * interval '1 second')
     ) AS ok`,
    [sessionIdValue, RECENT_AUTH_SECONDS],
  );
  return !!rows[0]?.ok;
}

export async function revokeSecuritySession(
  userId: string,
  sessionIdValue: string,
  revokedBy: string,
): Promise<boolean> {
  const rows = await query(
    `UPDATE user_sessions
        SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $3)
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [sessionIdValue, userId, revokedBy],
  );
  return !!rows[0];
}

export async function revokeUserSessions(
  userId: string,
  revokedBy: string,
  exceptSessionId?: string | null,
): Promise<number> {
  const rows = await query(
    `UPDATE user_sessions
        SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $2)
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($3::text IS NULL OR id <> $3)
      RETURNING id`,
    [userId, revokedBy, exceptSessionId ?? null],
  );
  return rows.length;
}

export async function cleanupSecurityRows(): Promise<void> {
  await query(`DELETE FROM login_throttle WHERE updated_at < now() - interval '7 days'`);
  await query(`DELETE FROM user_sessions WHERE expires_at < now() - interval '90 days'`);
}

function throttleKey(ip: string | undefined, email: string): string {
  return sha256(`${ip ?? 'unknown'}|${email.trim().toLowerCase()}`);
}

export async function loginThrottleStatus(ip: string | undefined, email: string): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const key = throttleKey(ip, email);
  const rows = await query<{ locked_until: Date | null }>(
    'SELECT locked_until FROM login_throttle WHERE key_hash = $1', [key],
  );
  const until = rows[0]?.locked_until ? new Date(rows[0].locked_until).getTime() : 0;
  const remaining = Math.ceil((until - Date.now()) / 1000);
  return { locked: remaining > 0, retryAfterSeconds: Math.max(0, remaining) };
}

export async function noteLoginFailure(
  ip: string | undefined,
  email: string,
): Promise<{ locked: boolean; justLocked: boolean; retryAfterSeconds: number }> {
  const key = throttleKey(ip, email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO login_throttle (key_hash, failure_count, window_started_at, updated_at)
       VALUES ($1,0,now(),now()) ON CONFLICT (key_hash) DO NOTHING`,
      [key],
    );
    const result = await client.query<any>(
      `SELECT failure_count, window_started_at, locked_until
         FROM login_throttle WHERE key_hash = $1 FOR UPDATE`,
      [key],
    );
    const row = result.rows[0];
    const now = Date.now();
    const windowStarted = new Date(row.window_started_at).getTime();
    const existingLock = row.locked_until ? new Date(row.locked_until).getTime() : 0;

    if (existingLock > now) {
      await client.query('COMMIT');
      return { locked: true, justLocked: false, retryAfterSeconds: Math.ceil((existingLock - now) / 1000) };
    }

    const count = now - windowStarted > LOGIN_WINDOW_MS ? 1 : Number(row.failure_count) + 1;
    const resetWindow = now - windowStarted > LOGIN_WINDOW_MS;
    const justLocked = count >= LOGIN_MAX_FAILURES;
    const lockedUntil = justLocked ? new Date(now + LOGIN_LOCK_MS) : null;
    await client.query(
      `UPDATE login_throttle
          SET failure_count = $2,
              window_started_at = CASE WHEN $3 THEN now() ELSE window_started_at END,
              locked_until = $4,
              updated_at = now()
        WHERE key_hash = $1`,
      [key, count, resetWindow, lockedUntil],
    );
    await client.query('COMMIT');
    return {
      locked: justLocked,
      justLocked,
      retryAfterSeconds: justLocked ? Math.ceil(LOGIN_LOCK_MS / 1000) : 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function clearLoginFailures(ip: string | undefined, email: string): Promise<void> {
  await query('DELETE FROM login_throttle WHERE key_hash = $1', [throttleKey(ip, email)]);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += BASE32[Number.parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(value: string): Buffer {
  const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function totpAt(secretValue: string, timeMs: number): string {
  const counter = Math.floor(timeMs / 30_000);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretValue)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(number).padStart(6, '0');
}

export function verifyTotp(secretValue: string, code: string, now = Date.now()): boolean {
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = totpAt(secretValue, now + offset);
    if (timingSafeEqual(Buffer.from(clean), Buffer.from(expected))) return true;
  }
  return false;
}

export function totpUri(email: string, secretValue: string): string {
  const issuer = 'Adam Financial Book';
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({
    secret: secretValue,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function mfaKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET is not set.');
  return createHash('sha256').update(raw).digest();
}

export function encryptMfaSecret(secretValue: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secretValue, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptMfaSecret(value: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = String(value ?? '').split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) throw new Error('Stored MFA secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', mfaKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
