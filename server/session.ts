/**
 * Passwords and the cookie that carries a session.
 *
 * Database-backed session state lives in security.ts. This file owns only the
 * password primitive and the signed cookie format, so the crypto stays easy to
 * test and reason about in isolation.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (secret: string, salt: Buffer, len: number) => Promise<Buffer>;

// Kept for backward compatibility with pre-Phase-6 cookies. New sessions use a
// role-specific lifetime from security.ts and always carry a persistent session id.
const DAYS = 30;
export const SESSION_DAYS = DAYS;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is not set.');
  return value;
}

/* ---------------- passwords ---------------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), 64);
  const expected = Buffer.from(keyB64, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Strong enough for a financial system without banning memorable passphrases. */
export function passwordComplaint(password: string): string | null {
  if (password.length < 12) return 'A password needs at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rule) => rule.test(password)).length;
  if (password.length < 18 && classes < 3) {
    return 'Use at least three of: lowercase, uppercase, numbers and symbols — or use an 18+ character passphrase.';
  }
  return null;
}

/** A strong generated password that is still practical to read over the phone. */
export function suggestPassword(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(14);
  const body = Array.from(bytes, (b) => letters[b % letters.length]).join('');
  return `A7!${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10)}`;
}

/* ---------------- the cookie ---------------- */

/**
 * New cookies carry a persistent session id in addition to the user, credential
 * version and expiry. Old four-part cookies are still accepted once so they can
 * be transparently upgraded by auth.ts after deployment.
 */
export function signSession(
  userId: string,
  version: number,
  sessionId?: string,
  expiresAtMs = Date.now() + DAYS * 86_400_000,
): string {
  const body = sessionId
    ? `${userId}.${version}.${sessionId}.${expiresAtMs}`
    : `${userId}.${version}.${expiresAtMs}`;
  return `${body}.${sign(body)}`;
}

export interface Session {
  userId: string;
  version: number;
  sessionId?: string;
  expiresAt: number;
}

export function readSession(cookie: string | undefined): Session | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4 && parts.length !== 5) return null;

  const legacy = parts.length === 4;
  const userId = parts[0];
  const version = parts[1];
  const sessionId = legacy ? undefined : parts[2];
  const expires = legacy ? parts[2] : parts[3];
  const mac = legacy ? parts[3] : parts[4];
  const body = legacy
    ? `${userId}.${version}.${expires}`
    : `${userId}.${version}.${sessionId}.${expires}`;
  const expected = sign(body);

  if (!mac || mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const parsedVersion = Number(version);
  if (!Number.isInteger(parsedVersion) || parsedVersion < 0) return null;
  if (!userId || (!legacy && !sessionId)) return null;
  return { userId, version: parsedVersion, sessionId, expiresAt };
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function cookieHeader(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `book_session=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}
