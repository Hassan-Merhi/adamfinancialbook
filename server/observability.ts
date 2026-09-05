import type { RequestHandler } from 'express';
import { newId, pool, query } from './db.js';
import { getMigrationStatus } from './migration.js';
import { readiness } from './readiness.js';
import { fireOperationalAlert, logOperationalEvent, type OperationalSeverity } from './alerts.js';

interface RequestMetricState {
  startedAt: number;
  requests: number;
  responses4xx: number;
  responses5xx: number;
  totalDurationMs: number;
  maxDurationMs: number;
  recentDurations: number[];
}

const requestMetrics: RequestMetricState = {
  startedAt: Date.now(),
  requests: 0,
  responses4xx: 0,
  responses5xx: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  recentDurations: [],
};

const RECENT_DURATION_LIMIT = 500;

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(p * ordered.length) - 1));
  return Math.round(ordered[index] * 10) / 10;
}

function routeName(path: string) {
  return path.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, '/:id').slice(0, 180);
}

export const requestTelemetry: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  const requestId = req.get('x-request-id')?.slice(0, 80) || newId('req');
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    requestMetrics.requests += 1;
    requestMetrics.totalDurationMs += durationMs;
    requestMetrics.maxDurationMs = Math.max(requestMetrics.maxDurationMs, durationMs);
    requestMetrics.recentDurations.push(durationMs);
    if (requestMetrics.recentDurations.length > RECENT_DURATION_LIMIT) requestMetrics.recentDurations.shift();
    if (res.statusCode >= 500) requestMetrics.responses5xx += 1;
    else if (res.statusCode >= 400) requestMetrics.responses4xx += 1;

    const detail = {
      requestId,
      method: req.method,
      path: routeName(req.path),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };
    if (res.statusCode >= 500) {
      logOperationalEvent('http.response.5xx', detail, 'error');
      if (requestMetrics.responses5xx % 3 === 0) {
        fireOperationalAlert('http.repeated_5xx', {
          ...detail,
          responses5xxSinceStart: requestMetrics.responses5xx,
        }, 'critical');
      }
    } else if (durationMs >= Number(process.env.SLOW_REQUEST_MS ?? 2_000)) {
      logOperationalEvent('http.request.slow', detail, 'warn');
    }
  });
  next();
};

export async function recordOperationalEvent(
  event: string,
  detail: Record<string, unknown> = {},
  severity: OperationalSeverity = 'warn',
  requestId?: string | null,
) {
  logOperationalEvent(event, detail, severity);
  try {
    await query(
      `INSERT INTO operational_events (id, severity, event, request_id, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [newId('evt'), severity, event, requestId ?? null, JSON.stringify(detail)],
    );
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      severity: 'error',
      event: 'operational_event.persist.failed',
      originalEvent: event,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function fireObservedFailure(
  event: string,
  detail: Record<string, unknown> = {},
  severity: OperationalSeverity = 'error',
  requestId?: string | null,
  alert = false,
) {
  void recordOperationalEvent(event, detail, severity, requestId);
  if (alert) fireOperationalAlert(event, detail, severity === 'error' ? 'critical' : severity);
}

export async function latestBackupStatus() {
  const rows = await query<{
    id: string;
    started_at: Date;
    completed_at: Date | null;
    status: 'running' | 'success' | 'failed';
    destination: string;
    bytes: string | number | null;
    checksum: string | null;
    migration_version: string | number | null;
    encrypted: boolean;
    error: string | null;
  }>(
    `SELECT id, started_at, completed_at, status, destination, bytes, checksum,
            migration_version, encrypted, error
       FROM backup_runs ORDER BY started_at DESC LIMIT 1`,
  ).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  const completedAt = row.completed_at ? new Date(row.completed_at).toISOString() : null;
  return {
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt,
    status: row.status,
    destination: row.destination,
    bytes: row.bytes === null ? null : Number(row.bytes),
    checksum: row.checksum?.trim() ?? null,
    migrationVersion: row.migration_version === null ? null : Number(row.migration_version),
    encrypted: row.encrypted,
    error: row.error,
    ageHours: completedAt ? Math.round(((Date.now() - Date.parse(completedAt)) / 3_600_000) * 10) / 10 : null,
  };
}

export async function operationsStatus() {
  const started = process.hrtime.bigint();
  let databaseLatencyMs: number | null = null;
  try {
    await pool.query('SELECT 1');
    databaseLatencyMs = Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10;
  } catch {
    databaseLatencyMs = null;
  }
  const [ready, migrations, backup, recentEvents] = await Promise.all([
    readiness(),
    getMigrationStatus().catch(() => null),
    latestBackupStatus(),
    query<{ severity: string; n: number }>(
      `SELECT severity, count(*)::int AS n
         FROM operational_events
        WHERE created_at >= now() - interval '24 hours'
        GROUP BY severity`,
    ).catch(() => []),
  ]);
  const bySeverity = Object.fromEntries(recentEvents.map((row) => [row.severity, Number(row.n)]));
  const memory = process.memoryUsage();
  return {
    ok: ready.ok && !!migrations && migrations.pending.length === 0,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
    database: {
      status: ready.database,
      latencyMs: databaseLatencyMs,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    },
    migrations: migrations ? {
      current: migrations.current,
      latest: migrations.latest,
      pending: migrations.pending,
    } : { current: null, latest: null, pending: ['unknown'] },
    backup,
    requests: {
      since: new Date(requestMetrics.startedAt).toISOString(),
      total: requestMetrics.requests,
      responses4xx: requestMetrics.responses4xx,
      responses5xx: requestMetrics.responses5xx,
      averageMs: requestMetrics.requests
        ? Math.round((requestMetrics.totalDurationMs / requestMetrics.requests) * 10) / 10
        : 0,
      p95Ms: percentile(requestMetrics.recentDurations, 0.95),
      maxMs: Math.round(requestMetrics.maxDurationMs * 10) / 10,
    },
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    events24h: {
      info: bySeverity.info ?? 0,
      warn: bySeverity.warn ?? 0,
      error: bySeverity.error ?? 0,
      critical: bySeverity.critical ?? 0,
    },
  };
}

export async function recentOperationalEvents(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  return query<{
    id: string;
    created_at: Date;
    severity: OperationalSeverity;
    event: string;
    request_id: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT id, created_at, severity, event, request_id, detail
       FROM operational_events ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
  ).then((rows) => rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    severity: row.severity,
    event: row.event,
    requestId: row.request_id,
    detail: row.detail,
  })));
}
