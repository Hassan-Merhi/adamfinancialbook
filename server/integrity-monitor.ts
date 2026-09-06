import { fireOperationalAlert, logOperationalEvent } from './alerts.js';
import { runIntegrityCheck } from './integrity.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startAlertingIntegrityMonitor(): void {
  if (process.env.NODE_ENV === 'test') return;

  const run = async () => {
    try {
      const result = await runIntegrityCheck();
      const detail = {
        checkedAt: result.checkedAt,
        errors: result.errors,
        warnings: result.warnings,
        issueCount: result.issueCount,
        issues: result.ok ? undefined : result.issues.slice(0, 50),
      };
      if (result.ok) {
        logOperationalEvent('accounting.integrity.ok', detail);
      } else {
        fireOperationalAlert('accounting.integrity.failed', detail, 'critical');
      }
    } catch (error) {
      fireOperationalAlert(
        'accounting.integrity.error',
        { error: error instanceof Error ? error.message : String(error) },
        'critical',
      );
    }
  };

  const first = setTimeout(run, 60_000);
  first.unref();
  const timer = setInterval(run, ONE_DAY_MS);
  timer.unref();
}
