import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 2 + Phase 7 deployment/performance certification', () => {
  it('keeps production startup fail-closed on environment and migration drift', () => {
    const render = read('render.yaml');
    const start = read('server/start.ts');
    const config = read('server/config.ts');

    expect(render).toContain('buildCommand: npm ci && npm run typecheck && npm test -- --passWithNoTests && npm run build');
    expect(render).toContain('startCommand: npm start');
    expect(render).toContain('healthCheckPath: /api/health/ready');
    expect(render).toContain('value: "22"');
    expect(start).toContain('await runMigrations()');
    expect(start).toContain('status.pending.length');
    expect(start.indexOf('await runMigrations()')).toBeLessThan(start.indexOf("await import('./index.js')"));
    expect(config).toContain("SESSION_SECRET must be at least 32 characters");
    expect(config).toContain("z.enum(['verify', 'no-verify', 'off'])");
    expect(config).toContain('PGPOOL_MAX');
  });

  it('exposes database pool pressure without turning transient load into a restart signal', () => {
    const readiness = read('server/readiness.ts');
    const health = read('server/health.ts');

    expect(readiness).toContain('total: pool.totalCount');
    expect(readiness).toContain('idle: pool.idleCount');
    expect(readiness).toContain('waiting: pool.waitingCount');
    expect(health).toContain('pool: state.pool');
    expect(readiness).not.toContain('pool.waitingCount >');
  });

  it('keeps focused server-side pagination/search and the current overview fast path', () => {
    const performance = read('server/performance.ts');
    const overview = read('server/current-overview.ts');
    const client = read('client/src/api.ts');

    expect(performance).toContain("router.get('/statement-page'");
    expect(performance).toContain("router.get('/search/entries'");
    expect(performance).toContain("router.get('/history-page'");
    expect(performance).toContain('LIMIT ${take}');
    expect(performance).toContain("to_tsvector('simple'");
    expect(overview).toContain('FROM effects');
    expect(overview).toContain('WHERE active = true');
    expect(client).toContain('/statement-page?');
    expect(client).toContain('/search/entries?');
  });

  it('keeps the established performance-index migration contract intact', () => {
    const migration = read('server/migrations/006_performance_indexes.sql');

    expect(migration).toContain('CREATE INDEX IF NOT EXISTS entries_active_recent_idx');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS entries_search_idx');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS effects_active_target_entry_idx');
  });
});
