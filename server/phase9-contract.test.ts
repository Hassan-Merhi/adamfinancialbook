import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 9 backup, recovery and observability contract', () => {
  it('uses authenticated encryption and a consistent PostgreSQL snapshot', () => {
    const backup = read('server/backup-service.ts');
    expect(backup).toContain("createCipheriv('aes-256-gcm'");
    expect(backup).toContain('scryptSync(secret(), salt, 32)');
    expect(backup).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(backup).toContain("MAGIC = Buffer.from('AFB9')");
    expect(backup).toContain("udt_name === 'bytea'");
    expect(backup).toContain('reseedOwnedSequences');
    expect(backup).not.toContain("process.env.SESSION_SECRET");
  });

  it('has a guarded restore that verifies accounting integrity and migrations', () => {
    const restore = read('server/restore.ts');
    expect(restore).toContain('RESTORE_DATABASE_URL');
    expect(restore).toContain("ALLOW_PRODUCTION_RESTORE !== '1'");
    expect(restore).toContain('runIntegrityCheck');
    expect(restore).toContain('restore.verified');
    expect(restore).toContain('runMigrations');
  });

  it('proves recovery against a separate PostgreSQL database in integration CI', () => {
    const recovery = read('server/recovery.integration.test.ts');
    const pkg = read('package.json');
    expect(recovery).toContain('CREATE DATABASE');
    expect(recovery).toContain("execFileSync(npx, ['tsx', 'server/restore.ts', file]");
    expect(recovery).toContain('for (const table of snapshot.tables)');
    expect(recovery).toContain('authentication failed');
    expect(pkg).toContain('server/recovery.integration.test.ts');
  });

  it('provisions automatic off-site backup and independent health monitoring', () => {
    const render = read('render.yaml');
    expect(render).toContain('healthCheckPath: /api/health/ready');
    expect(render).toContain('name: adam-financial-book-encrypted-backup');
    expect(render).toContain('startCommand: npm run backup:send');
    expect(render).toContain('name: adam-financial-book-health-monitor');
    expect(render).toContain('schedule: "*/10 * * * *"');
    expect(render).toContain('envVarKey: BACKUP_ENCRYPTION_KEY');
    expect(render).toContain('envVarKey: RENDER_EXTERNAL_URL');
  });

  it('keeps operations detail owner-only while exposing minimal readiness', () => {
    const operations = read('server/operations.ts');
    const health = read('server/health.ts');
    expect(operations).toContain('operationsRouter.use(ownerOnly)');
    expect(operations).toContain("'/operations/status'");
    expect(operations).toContain("'/operations/backup'");
    expect(health).toContain("'/health/live'");
    expect(health).toContain("'/health/ready'");
    expect(health).toContain('res.status(state.ok ? 200 : 503)');
  });

  it('tracks latency, 5xx, DB failures, failed sign-ins and translation failures', () => {
    const observability = read('server/observability.ts');
    const db = read('server/db.ts');
    const translate = read('server/translate.ts');
    expect(observability).toContain('http.repeated_5xx');
    expect(observability).toContain('http.request.slow');
    expect(observability).toContain("action IN ('sign-in refused','sign-in locked')");
    expect(db).toContain('database.connection.dropped');
    expect(translate).toContain('translation.provider.failed');
    expect(translate).toContain('translation.cache.write_failed');
  });

  it('never stores credential values in operational event details', () => {
    const alerts = read('server/alerts.ts');
    expect(alerts).toContain('password|secret|token|cookie|authorization|database_url|smtp_url');
    expect(alerts).toContain('safeDetail(detail)');
  });
});
