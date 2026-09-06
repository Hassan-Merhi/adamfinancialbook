import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bearerTokenFromAuthorization } from './backup-export';

function status(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

describe('durable backup export security boundary', () => {
  it('parses a bounded Bearer token without a user-controlled regular expression', () => {
    expect(bearerTokenFromAuthorization('Bearer a.b.c')).toBe('a.b.c');
    expect(bearerTokenFromAuthorization('bearer a.b.c')).toBe('a.b.c');

    for (const invalid of [undefined, '', 'Basic abc', 'Bearer ', 'Bearer a b', `Bearer ${'x'.repeat(17 * 1024)}`]) {
      try {
        bearerTokenFromAuthorization(invalid);
        throw new Error('Expected malformed authorization to be rejected.');
      } catch (error) {
        expect(status(error)).toBe(401);
      }
    }
  });

  it('keeps explicit route-local rate limiting on both machine endpoints', () => {
    const source = readFileSync(new URL('./backup-export.ts', import.meta.url), 'utf8');
    expect(source).toContain("rateLimit({");
    expect(source).toContain("backupExportRouter.post('/operations/backups/export', backupMachineLimiter");
    expect(source).toContain("backupExportRouter.post('/operations/backups/ack', backupMachineLimiter");
    expect(source).not.toContain('/^Bearer\\s+(.+)$/i');
  });
});
