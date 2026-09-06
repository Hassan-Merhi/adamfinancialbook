import { pool } from './db.js';
import { getMigrationStatus } from './migration.js';
import { ensureOperationsSchema } from './operations-schema.js';

const processStartedAt = Date.now();

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
  detail?: string;
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
    if (status.pending.length > 0) {
      return {
        ok: false,
        database: 'ok',
        migrations: 'pending',
        pendingMigrations: status.pending.length,
        currentMigration: status.current,
        latestMigration: status.latest,
        ...backup,
      };
    }
    const backupOk = backup.backups === 'current' || backup.backups === 'bootstrap';
    return {
      ok: backupOk,
      database: 'ok',
      migrations: 'current',
      pendingMigrations: 0,
      currentMigration: status.current,
      latestMigration: status.latest,
      ...backup,
      ...(!backupOk ? { detail: `Off-site encrypted backup status is ${backup.backups}.` } : {}),
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
      detail: error instanceof Error ? error.message : 'Unknown readiness failure',
    };
  }
}
