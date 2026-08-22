/**
 * Passwords and the cookie that carries a session.
 *
 * Deliberately knows nothing about the database, so it can be tested on its own
 * and reasoned about without a book in front of you.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (secret: string, salt: Buffer, len: number) => Promise<Buffer>;

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

/** Long enough to be worth having, short enough that people will use it. */
export function passwordComplaint(password: string): string | null {
  if (password.length < 8) return 'A password needs at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

/** Something you can read down the phone: no l, 1, O or 0 to argue about. */
export function suggestPassword(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  return Array.from(bytes, (b) => letters[b % letters.length]).join('').replace(/(.{5})(.{5})/, '$1-$2-');
}

/* ---------------- the cookie ---------------- */

/**
 * The session carries the user, which version of their credentials it belongs
 * to, and when it dies — signed, so none of the three can be edited.
 *
 * The version is what makes "sign everyone else out" possible: change a
 * password and the number moves, and every cookie issued before it stops
 * working, wherever it is.
 */
export function signSession(userId: string, version: number): string {
  const expires = Date.now() + DAYS * 86_400_000;
  const body = `${userId}.${version}.${expires}`;
  return `${body}.${sign(body)}`;
}

export interface Session { userId: string; version: number }

export function readSession(cookie: string | undefined): Session | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4) return null;
  const [userId, version, expires, mac] = parts;
  const expected = sign(`${userId}.${version}.${expires}`);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return null;
  return { userId, version: Number(version) };
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
