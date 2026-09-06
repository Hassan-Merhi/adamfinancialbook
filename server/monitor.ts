import 'dotenv/config';
import { sendOperationalAlert, logOperationalEvent } from './alerts.js';

interface ReadinessPayload {
  ok?: unknown;
  database?: unknown;
  migrations?: unknown;
  pendingMigrations?: unknown;
  currentMigration?: unknown;
  latestMigration?: unknown;
}

const base = process.env.APP_HEALTH_URL;
if (!base) throw new Error('APP_HEALTH_URL is required for the external production monitor.');
const url = base.endsWith('/api/health/ready')
  ? base
  : `${base.replace(/\/$/, '')}/api/health/ready`;

try {
  const started = Date.now();
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.HEALTH_MONITOR_TIMEOUT_MS ?? 12_000)),
  });
  let payload: ReadinessPayload | null = null;
  try { payload = await response.json() as ReadinessPayload; } catch { /* status below is enough */ }
  const durationMs = Date.now() - started;

  if (
    !payload
    || !response.ok
    || payload.ok !== true
    || payload.database !== 'ok'
    || payload.migrations !== 'current'
    || Number(payload.pendingMigrations ?? -1) !== 0
  ) {
    throw new Error([
      `health endpoint returned HTTP ${response.status}`,
      `ok=${String(payload?.ok)}`,
      `database=${String(payload?.database)}`,
      `migrations=${String(payload?.migrations)}`,
      `pendingMigrations=${String(payload?.pendingMigrations)}`,
    ].join(' '));
  }

  logOperationalEvent('production.health.ok', {
    url,
    durationMs,
    database: payload.database,
    migrations: payload.migrations,
    currentMigration: payload.currentMigration,
    latestMigration: payload.latestMigration,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = await sendOperationalAlert(
    'production.health.failed',
    { url, error: message },
    'critical',
    0,
  );
  if (!result.delivered) {
    console.error('Production health failure could not be delivered to an alert destination.');
  }
  process.exitCode = 1;
}
