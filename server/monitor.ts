import 'dotenv/config';
import { sendOperationalAlert, logOperationalEvent } from './alerts.js';

const url = process.env.APP_HEALTH_URL;
if (!url) throw new Error('APP_HEALTH_URL is required for the external production monitor.');

try {
  const started = Date.now();
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.HEALTH_MONITOR_TIMEOUT_MS ?? 12_000)),
  });
  let payload: { ok?: unknown } | null = null;
  try { payload = await response.json() as { ok?: unknown }; } catch { /* status below is enough */ }
  const durationMs = Date.now() - started;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`health endpoint returned HTTP ${response.status} with ok=${String(payload?.ok)}`);
  }
  logOperationalEvent('production.health.ok', { url, durationMs });
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
