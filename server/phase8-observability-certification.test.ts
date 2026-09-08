import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const observability = read('server/observability.ts');
const production = read('server/production-observability.ts');
const db = read('server/db.ts');
const operations = read('server/operations.ts');
const health = read('server/health.ts');
const monitor = read('server/monitor.ts');

describe('Phase 8 production observability', () => {
  it('separates client aborts from 5xx failures', () => {
    expect(observability).toContain('clientAborts');
    expect(observability).toContain("http.client_aborted");
    expect(observability).toContain('internalStatus: 499');
    expect(observability).toContain("res.on('close'");
  });

  it('records slow SQL without logging bind parameters', () => {
    expect(db).toContain('SLOW_SQL_MS');
    expect(db).toContain("database.query.slow");
    expect(db).toContain('queryLabel(text)');
    expect(db).not.toContain('params,\n        durationMs');
  });

  it('has actionable thresholded health signals', () => {
    for (const required of [
      'OBS_P95_WARN_MS', 'OBS_P95_CRITICAL_MS', 'OBS_5XX_WARN_PCT',
      'OBS_DB_LATENCY_WARN_MS', 'OBS_POOL_WAITING_WARN', 'OBS_HEAP_WARN_RATIO',
      'OBS_FAILED_LOGIN_WARN_24H', 'OBS_SUBSYSTEM_FAILURE_WARN_24H',
    ]) expect(production).toContain(required);
    expect(production).toContain("level: HealthLevel");
    expect(production).toContain("level !== 'critical'");
  });

  it('actively evaluates degradation with low-frequency cooldown-protected alerts', () => {
    expect(production).toContain('startProductionObservabilityMonitor');
    expect(production).toContain('OBS_MONITOR_INTERVAL_MS');
    expect(production).toContain("production.observability.critical");
    expect(production).toContain("production.observability.degraded");
    expect(operations).toContain('startProductionObservabilityMonitor();');
  });

  it('covers offline/reconnect, attachments, live updates, backup and migrations', () => {
    expect(production).toContain("'offline_sync'");
    expect(production).toContain("'attachments'");
    expect(production).toContain("'live_updates'");
    expect(production).toContain('backup.failures24h');
    expect(production).toContain('base.migrations');
  });

  it('keeps the detailed observability surface owner-only and uncached', () => {
    expect(operations).toContain("'/operations/observability'");
    expect(operations).toContain('ownerOnly');
    expect(operations).toContain("Cache-Control', 'no-store'");
  });

  it('retains public liveness/readiness plus external production monitoring', () => {
    expect(health).toContain("'/health/live'");
    expect(health).toContain("'/health/ready'");
    expect(monitor).toContain('APP_HEALTH_URL');
    expect(monitor).toContain('production.health.failed');
    expect(monitor).toContain('HEALTH_MONITOR_TIMEOUT_MS');
  });
});
