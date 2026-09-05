import nodemailer from 'nodemailer';

export type OperationalSeverity = 'info' | 'warn' | 'error' | 'critical';

const lastAlertAt = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

function safeDetail(detail: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(detail).filter(([key]) =>
    !/(password|secret|token|cookie|authorization|database_url|smtp_url)/i.test(key)));
}

export function logOperationalEvent(
  event: string,
  detail: Record<string, unknown> = {},
  severity: OperationalSeverity = 'info',
) {
  console[severity === 'info' ? 'log' : severity === 'warn' ? 'warn' : 'error'](JSON.stringify({
    ts: new Date().toISOString(),
    service: process.env.RENDER_SERVICE_NAME ?? 'adam-financial-book',
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
    severity,
    event,
    ...safeDetail(detail),
  }));
}

async function postWebhook(event: string, severity: OperationalSeverity, detail: Record<string, unknown>) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: process.env.RENDER_SERVICE_NAME ?? 'adam-financial-book',
      release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
      event,
      severity,
      occurredAt: new Date().toISOString(),
      detail: safeDetail(detail),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`alert webhook returned ${response.status}`);
  return true;
}

async function sendEmail(event: string, severity: OperationalSeverity, detail: Record<string, unknown>) {
  const smtp = process.env.SMTP_URL;
  const to = process.env.ALERT_TO ?? process.env.REPORT_TO;
  if (!smtp || !to) return false;
  const from = process.env.ALERT_FROM ?? process.env.REPORT_FROM ?? to;
  const transport = nodemailer.createTransport(smtp);
  const body = JSON.stringify({
    service: process.env.RENDER_SERVICE_NAME ?? 'adam-financial-book',
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
    event,
    severity,
    occurredAt: new Date().toISOString(),
    detail: safeDetail(detail),
  }, null, 2);
  await transport.sendMail({
    from,
    to,
    subject: `[Adam Financial Book] ${severity.toUpperCase()}: ${event}`,
    text: body,
  });
  return true;
}

export async function sendOperationalAlert(
  event: string,
  detail: Record<string, unknown> = {},
  severity: OperationalSeverity = 'critical',
  cooldownMs = DEFAULT_COOLDOWN_MS,
): Promise<{ delivered: boolean; throttled: boolean }> {
  logOperationalEvent(event, detail, severity);
  const now = Date.now();
  const previous = lastAlertAt.get(event) ?? 0;
  if (cooldownMs > 0 && now - previous < cooldownMs) return { delivered: false, throttled: true };
  lastAlertAt.set(event, now);

  const results = await Promise.allSettled([
    postWebhook(event, severity, detail),
    sendEmail(event, severity, detail),
  ]);
  const delivered = results.some((result) => result.status === 'fulfilled' && result.value === true);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        severity: 'error',
        event: 'alert.delivery.failed',
        alertEvent: event,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }));
    }
  }
  return { delivered, throttled: false };
}

export function fireOperationalAlert(
  event: string,
  detail: Record<string, unknown> = {},
  severity: OperationalSeverity = 'critical',
  cooldownMs = DEFAULT_COOLDOWN_MS,
) {
  void sendOperationalAlert(event, detail, severity, cooldownMs).catch((error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      severity: 'error',
      event: 'alert.dispatch.failed',
      alertEvent: event,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}
