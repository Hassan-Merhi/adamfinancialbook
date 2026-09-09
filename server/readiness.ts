import { pool } from './db.js';
import { getMigrationStatus } from './migration.js';
import { ensureOperationsSchema } from './operations-schema.js';

const processStartedAt = Date.now();

export interface DatabasePoolReadiness {
  max: number;
  total: number;
  idle: number;
  waiting: number;
}

export interface ReadinessResult {
  ok: boolean;
  database: 'ok' | 'error';
  migrations: 'current' | 'pending' | 'error';
  pendingMigrations: number;
  currentMigration: number | null;
  latestMigration: number | null;
  backups: 'current' | 'bootstrap' | 'missing' | 'stale' | 'error';
  latestBackupAt: string | null;
  backupAgeHours: number | null;
  pool: DatabasePoolReadiness;
  detail?: string;
}

function databasePoolReadiness(): DatabasePoolReadiness {
  return {
    max: pool.options.max,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

async function backupReadiness() {
  await ensureOperationsSchema();
  const rows = await pool.query<{ delivered_at: Date }>(
    `SELECT delivered_at
       FROM backup_runs
      WHERE status = 'success'
        AND destination = 'github-actions-artifact'
        AND delivered_at IS NOT NULL
      ORDER BY delivered_at DESC
      LIMIT 1`,
  );
  const row = rows.rows[0];
  const staleHours = Math.max(24, Number(process.env.BACKUP_STALE_HOURS ?? 36));
  if (!row) {
    const uptimeHours = (Date.now() - processStartedAt) / 3_600_000;
    const bootstrapHours = Math.max(24, Number(process.env.BACKUP_BOOTSTRAP_HOURS ?? 30));
    return {
      backups: uptimeHours <= bootstrapHours ? 'bootstrap' as const : 'missing' as const,
      latestBackupAt: null,
      backupAgeHours: null,
    };
  }
  const latestBackupAt = new Date(row.delivered_at).toISOString();
  const backupAgeHours = Math.round(((Date.now() - Date.parse(latestBackupAt)) / 3_600_000) * 10) / 10;
  return {
    backups: backupAgeHours <= staleHours ? 'current' as const : 'stale' as const,
    latestBackupAt,
    backupAgeHours,
  };
}

export async function readiness(): Promise<ReadinessResult> {
  try {
    await pool.query('SELECT 1');
    const [status, backup] = await Promise.all([getMigrationStatus(), backupReadiness()]);
    const poolState = databasePoolReadiness();
    if (status.pending.length > 0) {
      return {
        ok: false,
        database: 'ok',
        migrations: 'pending',
        pendingMigrations: status.pending.length,
        currentMigration: status.current,
        latestMigration: status.latest,
        ...backup,
        pool: poolState,
      };
    }

    // Readiness answers one question: can this exact process safely receive
    // traffic? Database connectivity and migration state are deployment-critical.
    // Off-site backup freshness is intentionally reported alongside readiness but
    // does NOT make the process unready. Making a stale backup return HTTP 503
    // creates a deployment deadlock on platforms that health-check this endpoint:
    // the new SHA never becomes live, so the exact-SHA backup workflow can never
    // export/acknowledge the backup that would make the endpoint healthy again.
    // Backup freshness remains a critical observability signal and is still a
    // hard requirement in Production Acceptance / Stable Release certification.
    const backupHealthy = backup.backups === 'current' || backup.backups === 'bootstrap';
    return {
      ok: true,
      database: 'ok',
      migrations: 'current',
      pendingMigrations: 0,
      currentMigration: status.current,
      latestMigration: status.latest,
      ...backup,
      pool: poolState,
      ...(!backupHealthy ? { detail: `Off-site encrypted backup status is ${backup.backups}; traffic is safe, release certification remains blocked.` } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      database: 'error',
      migrations: 'error',
      pendingMigrations: -1,
      currentMigration: null,
      latestMigration: null,
      backups: 'error',
      latestBackupAt: null,
      backupAgeHours: null,
      pool: databasePoolReadiness(),
      detail: error instanceof Error ? error.message : 'Unknown readiness failure',
    };
  }
}
