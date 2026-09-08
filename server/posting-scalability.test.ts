import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('financial posting scalability contract', () => {
  it('keeps posting independent from full ledger history', () => {
    const posting = read('server/posting.ts');
    expect(posting).toContain('loadPostingCatalog');
    expect(posting).toContain('savePostedEntry');
    expect(posting).toContain('WHERE client_ref = $1 LIMIT 1');
    expect(posting).toContain('withLoanEffects(input, catalog)');
    expect(posting).not.toContain('loadBook');
    expect(posting).not.toContain('SELECT * FROM entries ORDER BY occurred_on');
    expect(posting).not.toContain('SELECT * FROM effects WHERE active = true ORDER BY id');
  });

  it('mounts the focused posting router before the legacy fallback', () => {
    const index = read('server/index.ts');
    const mounted = index.indexOf("app.use('/api', postingRouter)");
    const fallback = index.indexOf("app.post('/api/entries'");
    expect(mounted).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(-1);
    expect(mounted).toBeLessThan(fallback);
  });
});
