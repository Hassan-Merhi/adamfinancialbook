import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const performance = read('server/performance.ts');
const posting = read('server/posting.ts');
const currentOverview = read('server/current-overview.ts');
const searchOptimized = read('server/search-optimized.ts');
const start = read('server/start.ts');
const indexes = read('server/migrations/006_performance_indexes.sql');
const api = read('client/src/api.ts');
const app = read('client/src/App.tsx');

describe('Phase 7 performance and scalability architecture', () => {
  it('keeps high-volume list APIs server-paginated and bounded', () => {
    expect(performance).toContain("router.get('/statement-page'");
    expect(performance).toContain("router.get('/history-page'");
    expect(performance).toContain('decodePageCursor');
    expect(performance).toContain('decodeAuditCursor');
    expect(performance).toContain('LIMIT ${take}');
    expect(performance).toContain('boundedLimit(params.get(\'limit\'), 50, 100)');
    expect(api).toContain('/statement-page?');
    expect(api).toContain('/history-page?');
    expect(api).toContain('/files-page?');
  });

  it('keeps search server-side, indexed and hard bounded', () => {
    expect(start).toContain('optimizedSearchRouter');
    expect(searchOptimized).toContain("router.get('/search/entries'");
    expect(searchOptimized).toContain("websearch_to_tsquery('simple', $1)");
    expect(searchOptimized).toContain('LIMIT $3');
    expect(searchOptimized).toContain('max = 25');
    expect(indexes).toContain('CREATE INDEX IF NOT EXISTS entries_search_idx');
    expect(indexes).toContain('USING GIN');
  });

  it('forbids whole-ledger reads from financial posting and current overview hot paths', () => {
    expect(posting).not.toMatch(/SELECT\s+\*\s+FROM\s+entries/i);
    expect(currentOverview).not.toMatch(/SELECT\s+\*\s+FROM\s+entries/i);
    expect(searchOptimized).not.toMatch(/SELECT\s+\*\s+FROM\s+entries/i);
    expect(posting).toContain('client_ref');
  });

  it('preserves focused partial indexes for recent reads and effects', () => {
    for (const required of [
      'entries_active_recent_idx',
      'entries_active_account_idx',
      'entries_active_to_account_idx',
      'effects_active_target_entry_idx',
      'effects_active_loan_entry_idx',
      'attachments_created_recent_idx',
    ]) expect(indexes).toContain(required);
  });

  it('mounts optimized current-overview and search routers before legacy performance fallbacks', () => {
    const current = start.indexOf('currentOverviewRouter');
    const search = start.indexOf('optimizedSearchRouter');
    const legacy = start.indexOf('performanceRouter');
    expect(current).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(current).toBeLessThan(legacy);
    expect(search).toBeLessThan(legacy);
  });

  it('does not reintroduce interval polling in the main application data layer', () => {
    expect(api).not.toContain('setInterval(');
    expect(app).not.toContain('setInterval(');
  });
});
