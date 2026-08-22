import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => { process.env.SESSION_SECRET = 'a-secret-for-the-tests'; });

const {
  checkPassword, cookieHeader, hashPassword, passwordComplaint,
  readCookie, readSession, signSession, suggestPassword,
} = await import('../server/session.js');

describe('passwords', () => {
  it('is stored as a hash, never as itself', async () => {
    const stored = await hashPassword('the-real-password');
    expect(stored).not.toContain('the-real-password');
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('recognises the right one and refuses the rest', async () => {
    const stored = await hashPassword('the-real-password');
    expect(await checkPassword('the-real-password', stored)).toBe(true);
    expect(await checkPassword('the-real-passwore', stored)).toBe(false);
    expect(await checkPassword('', stored)).toBe(false);
  });

  it('salts, so two people with the same password do not look alike', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('asks for something long enough to be worth having', () => {
    expect(passwordComplaint('short')).toContain('8 characters');
    expect(passwordComplaint('long-enough-now')).toBeNull();
  });

  it('suggests one that can be read down the phone', () => {
    const suggested = suggestPassword();
    expect(suggested.length).toBeGreaterThan(11);
    expect(suggested).not.toMatch(/[l1O0]/);   // nothing anyone can mishear
  });
});

describe('the session cookie', () => {
  it('comes back as the person it was made for', () => {
    expect(readSession(signSession('usr_1', 3))).toEqual({ userId: 'usr_1', version: 3 });
  });

  it('cannot be edited', () => {
    const cookie = signSession('usr_1', 0);
    const [id, version, expires, mac] = cookie.split('.');
    expect(readSession(`usr_2.${version}.${expires}.${mac}`)).toBeNull();          // another person
    expect(readSession(`${id}.9.${expires}.${mac}`)).toBeNull();                    // another version
    expect(readSession(`${id}.${version}.${Number(expires) + 86_400_000}.${mac}`)).toBeNull();  // a longer life
    expect(readSession(`${id}.${version}.${expires}.${mac.slice(0, -1)}x`)).toBeNull();          // a forged signature
  });

  it('refuses nonsense rather than throwing', () => {
    expect(readSession(undefined)).toBeNull();
    expect(readSession('')).toBeNull();
    expect(readSession('nonsense')).toBeNull();
    expect(readSession('a.b.c.d')).toBeNull();
  });

  it('will not travel to another site, or be read by a script', () => {
    const header = cookieHeader('value', 3600);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });

  it('finds its cookie among others', () => {
    expect(readCookie('a=1; book_session=abc.def; z=9', 'book_session')).toBe('abc.def');
    expect(readCookie('a=1', 'book_session')).toBeUndefined();
  });
});
