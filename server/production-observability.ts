import { pool, query } from './db.js';
import { operationsStatus } from './observability.js';

type HealthLevel = 'ok' | 'warn' | 'critical';

export interface ObservabilitySignal {
  level: HealthLevel;
  metric: string;
  value: number | string | boolean | null;
  threshold?: number | string;
  message: string;
}

const clampPct = (value: number) => Math.round(value * 1000) / 10;

function signal(
  level: HealthLevel,
  metric: string,
  value: number | string | boolean | null,
  message: string,
  threshold?: number | string,
): ObservabilitySignal {
  return { level, metric, value, message, ...(threshold === undefined ? {} : { threshold }) };
}

export async function productionObservabilitySnapshot() {
  const base = await operationsStatus();
  const [eventRows, recentBackupFailureRows] = await Promise.all([
    query<{ family: string; failures: number }>(`
      SELECT CASE
        WHEN event LIKE 'offline.%' OR event LIKE 'sync.%' THEN 'offline_sync'
        WHEN event LIKE 'attachment.%' OR event LIKE 'receipt.%' THEN 'attachments'
        WHEN event LIKE 'live.%' OR event LIKE 'sse.%' THEN 'live_updates'
        WHEN event LIKE 'database.%' THEN 'database'
        WHEN event LIKE 'backup.%' THEN 'backup'
        ELSE 'other'
      END AS family,
      count(*) FILTER (WHERE severity IN ('error','critical'))::int AS failures
      FROM operational_events
      WHERE created_at >= now() - interval '24 hours'
      GROUP BY 1
    `).catch(() => []),
    query<{ n: number }>(`
      SELECT count(*)::int AS n
      FROM backup_runs
      WHERE started_at >= now() - interval '24 hours' AND status = 'failed'
    `).catch(() => []),
  ]);

  const failures24h = Object.fromEntries(eventRows.map((row) => [row.family, Number(row.failures)]));
  const req = base.requests;
  const request5xxPct = req.total ? clampPct(req.responses5xx / req.total) : 0;
  const heapRatio = base.memory.heapTotalMb ? base.memory.heapUsedMb / base.memory.heapTotalMb : 0;
  const cpu = process.cpuUsage();
  const cpuSeconds = Math.round(((cpu.user + cpu.system) / 1_000_000) * 10) / 10;

  const thresholds = {
    requestP95WarnMs: Number(process.env.OBS_P95_WARN_MS ?? 1_500),
    requestP95CriticalMs: Number(process.env.OBS_P95_CRITICAL_MS ?? 3_000),
    fiveXxWarnPct: Number(process.env.OBS_5XX_WARN_PCT ?? 1),
    fiveXxCriticalPct: Number(process.env.OBS_5XX_CRITICAL_PCT ?? 3),
    dbLatencyWarnMs: Number(process.env.OBS_DB_LATENCY_WARN_MS ?? 250),
    dbLatencyCriticalMs: Number(process.env.OBS_DB_LATENCY_CRITICAL_MS ?? 1_000),
    poolWaitingWarn: Number(process.env.OBS_POOL_WAITING_WARN ?? 1),
    heapWarnRatio: Number(process.env.OBS_HEAP_WARN_RATIO ?? 0.85),
    heapCriticalRatio: Number(process.env.OBS_HEAP_CRITICAL_RATIO ?? 0.95),
    failedLoginWarn24h: Number(process.env.OBS_FAILED_LOGIN_WARN_24H ?? 20),
    subsystemFailureWarn24h: Number(process.env.OBS_SUBSYSTEM_FAILURE_WARN_24H ?? 3),
  };

  const signals: ObservabilitySignal[] = [];
  if (!base.ok) signals.push(signal('critical', 'readiness', false, 'Readiness or migration state is unhealthy.'));
  if (base.backup?.stale) signals.push(signal('critical', 'backup.ageHours', base.backup.ageHours, 'Latest successful backup is stale.', Number(process.env.BACKUP_STALE_HOURS ?? 30)));
  if (Number(recentBackupFailureRows[0]?.n ?? 0) > 0) signals.push(signal('critical', 'backup.failures24h', Number(recentBackupFailureRows[0]?.n ?? 0), 'At least one backup failed in the last 24 hours.', 0));

  if (req.p95Ms >= thresholds.requestP95CriticalMs) signals.push(signal('critical', 'http.p95Ms', req.p95Ms, 'HTTP p95 latency is critically high.', thresholds.requestP95CriticalMs));
  else if (req.p95Ms >= thresholds.requestP95WarnMs) signals.push(signal('warn', 'http.p95Ms', req.p95Ms, 'HTTP p95 latency is elevated.', thresholds.requestP95WarnMs));

  if (request5xxPct >= thresholds.fiveXxCriticalPct) signals.push(signal('critical', 'http.5xxPct', request5xxPct, '5xx response rate is critically high.', thresholds.fiveXxCriticalPct));
  else if (request5xxPct >= thresholds.fiveXxWarnPct) signals.push(signal('warn', 'http.5xxPct', request5xxPct, '5xx response rate is elevated.', thresholds.fiveXxWarnPct));

  const dbLatency = base.database.latencyMs;
  if (dbLatency === null || dbLatency >= thresholds.dbLatencyCriticalMs) signals.push(signal('critical', 'database.latencyMs', dbLatency, 'Database latency is unavailable or critically high.', thresholds.dbLatencyCriticalMs));
  else if (dbLatency >= thresholds.dbLatencyWarnMs) signals.push(signal('warn', 'database.latencyMs', dbLatency, 'Database latency is elevated.', thresholds.dbLatencyWarnMs));

  if (base.database.pool.waiting >= thresholds.poolWaitingWarn) signals.push(signal('warn', 'database.pool.waiting', base.database.pool.waiting, 'Requests are waiting for database connections.', thresholds.poolWaitingWarn));
  if (heapRatio >= thresholds.heapCriticalRatio) signals.push(signal('critical', 'memory.heapRatio', Math.round(heapRatio * 1000) / 1000, 'Heap utilization is critically high.', thresholds.heapCriticalRatio));
  else if (heapRatio >= thresholds.heapWarnRatio) signals.push(signal('warn', 'memory.heapRatio', Math.round(heapRatio * 1000) / 1000, 'Heap utilization is elevated.', thresholds.heapWarnRatio));
  if (base.security.failedLogins24h >= thresholds.failedLoginWarn24h) signals.push(signal('warn', 'security.failedLogins24h', base.security.failedLogins24h, 'Failed login activity is elevated.', thresholds.failedLoginWarn24h));

  for (const family of ['offline_sync', 'attachments', 'live_updates'] as const) {
    const failures = Number(failures24h[family] ?? 0);
    if (failures >= thresholds.subsystemFailureWarn24h) signals.push(signal('warn', `${family}.failures24h`, failures, `${family.replace('_', ' ')} failures are elevated.`, thresholds.subsystemFailureWarn24h));
  }

  const level: HealthLevel = signals.some((item) => item.level === 'critical')
    ? 'critical'
    : signals.some((item) => item.level === 'warn') ? 'warn' : 'ok';

  return {
    level,
    ok: level !== 'critical',
    checkedAt: new Date().toISOString(),
    release: base.release,
    signals,
    thresholds,
    http: { ...req, fiveXxPct: request5xxPct },
    database: base.database,
    migrations: base.migrations,
    backup: base.backup,
    security: base.security,
    memory: { ...base.memory, heapRatio: Math.round(heapRatio * 1000) / 1000 },
    process: { uptimeSeconds: base.uptimeSeconds, cpuSeconds },
    subsystemFailures24h: {
      offlineSync: Number(failures24h.offline_sync ?? 0),
      attachments: Number(failures24h.attachments ?? 0),
      liveUpdates: Number(failures24h.live_updates ?? 0),
      database: Number(failures24h.database ?? 0),
      backup: Number(failures24h.backup ?? 0),
    },
    events24h: base.events24h,
    poolCapacity: { max: Number(process.env.PGPOOL_MAX ?? 8), total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  };
}
