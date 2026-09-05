import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './config.js';

const base = {
  DATABASE_URL: 'postgres://user:password@localhost:5432/book',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};

describe('production environment validation', () => {
  it('accepts a complete production environment', () => {
    const config = validateEnvironment({ ...base, NODE_ENV: 'production', PORT: '10000', PGSSL: 'verify' });
    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(10000);
    expect(config.PGSSL).toBe('verify');
  });

  it('rejects a missing database', () => {
    expect(() => validateEnvironment({ SESSION_SECRET: base.SESSION_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('rejects a weak session secret', () => {
    expect(() => validateEnvironment({ DATABASE_URL: base.DATABASE_URL, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('treats blank optional values as defaults', () => {
    const config = validateEnvironment({ ...base, PORT: '', PGSSL: '', PGPOOL_MAX: '' });
    expect(config.PORT).toBe(5000);
    expect(config.PGSSL).toBe('verify');
    expect(config.PGPOOL_MAX).toBe(8);
  });
});
