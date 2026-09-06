import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Render Phase 3 production monitoring and alerting contract', () => {
  it('keeps the Render health-monitor cron configured every ten minutes', () => {
    const render = read('render.yaml');
    expect(render).toContain('name: adam-financial-book-health-monitor');
    expect(render).toContain('schedule: "*/10 * * * *"');
    expect(render).toContain('startCommand: npm run monitor');
    expect(render).toContain('key: APP_HEALTH_URL');
    expect(render).toContain('key: HEALTH_MONITOR_TIMEOUT_MS');
  });

  it('validates database and migration readiness rather than only HTTP status', () => {
    const monitor = read('server/monitor.ts');
    expect(monitor).toContain("payload?.database === 'ok'");
    expect(monitor).toContain("payload?.migrations === 'current'");
    expect(monitor).toContain('Number(payload?.pendingMigrations ?? -1) === 0');
    expect(monitor).toContain("sendOperationalAlert(\n    'production.health.failed'");
    expect(monitor).toContain('process.exitCode = 1');
  });

  it('dispatches critical accounting-integrity alerts and keeps backup alerts intact', () => {
    const integrityMonitor = read('server/integrity-monitor.ts');
    const start = read('server/start.ts');
    const backup = read('server/backup-service.ts');
    const backupMail = read('server/backup-mail.ts');

    expect(start).toContain("import('./integrity-monitor.js')");
    expect(integrityMonitor).toContain("fireOperationalAlert('accounting.integrity.failed'");
    expect(integrityMonitor).toContain("'accounting.integrity.error'");
    expect(backup).toContain("fireOperationalAlert('backup.failed'");
    expect(backupMail).toContain("fireOperationalAlert('backup.delivery.failed'");
  });

  it('has an independent external monitor with a real GitHub incident-delivery path', () => {
    const workflow = read('.github/workflows/production-health-monitor.yml');
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain('https://adamfinancialbook.onrender.com/api/health/ready');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('[Production Monitor] Adam Financial Book readiness failure');
    expect(workflow).toContain("github('/issues', 'POST'");
    expect(workflow).toContain("'state': 'closed'");
    expect(workflow).toContain("payload.get('database') == 'ok'");
    expect(workflow).toContain("payload.get('migrations') == 'current'");
  });
});
