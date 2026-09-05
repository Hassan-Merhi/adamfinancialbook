/**
 * Passwords and the cookie that carries a session.
 *
 * Database-backed session state lives in security.ts. This file owns only the
 * password primitive and the signed cookie format, so the crypto stays easy to
 * test and reason about in isolation.
 */
import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const STRONG_SCRYPT: ScryptOptions = {
  N: 1 << 17,
  r: 8,
  p: 1,
  maxmem: 192 * 1024 * 1024,
};

function deriveScrypt(secret: string, salt: Buffer, len: number, options?: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, derivedKey: Buffer) => {
      if (error) reject(error);
      else resolve(derivedKey);
    };
    if (options) scryptCb(secret, salt, len, options, done);
    else scryptCb(secret, salt, len, done);
  });
}

// Kept for backward compatibility with pre-Phase-6 cookies. New sessions use a
// role-specific lifetime from security.ts and always carry a persistent session id.
const DAYS = 30;
export const SESSION_DAYS = DAYS;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is not set.');
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveScrypt(password, salt, 64, STRONG_SCRYPT);
  return `scrypt-v2$${STRONG_SCRYPT.N}$${STRONG_SCRYPT.r}$${STRONG_SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  let key: Buffer;
  let expected: Buffer;

  if (parts[0] === 'scrypt-v2' && parts.length === 6) {
    const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || N < (1 << 14) || N > (1 << 20)) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32) return false;
    if (!Number.isInteger(p) || p < 1 || p > 16) return false;
    key = await deriveScrypt(password, Buffer.from(saltB64, 'base64'), 64, {
      N,
      r,
      p,
      maxmem: Math.max(192 * 1024 * 1024, 128 * N * r + 32 * 1024 * 1024),
    });
    expected = Buffer.from(keyB64, 'base64');
  } else if (parts[0] === 'scrypt' && parts.length === 3) {
    // Legacy hashes used Node's historical defaults. Keep verification so
    // existing users are not locked out; newly set passwords use scrypt-v2.
    const [, saltB64, keyB64] = parts;
    key = await deriveScrypt(password, Buffer.from(saltB64, 'base64'), 64);
    expected = Buffer.from(keyB64, 'base64');
  } else {
    return false;
  }

  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordComplaint(password: string): string | null {
  if (password.length < 12) return 'A password needs at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rule) => rule.test(password)).length;
  if (password.length < 18 && classes < 3) {
    return 'Use at least three of: lowercase, uppercase, numbers and symbols — or use an 18+ character passphrase.';
  }
  return null;
}

export function suggestPassword(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const body = Array.from({ length: 14 }, () => letters[randomInt(letters.length)]).join('');
  return `A7!${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10)}`;
}

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
