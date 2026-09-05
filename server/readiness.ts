import { pool } from './db.js';
import { getMigrationStatus } from './migration.js';

export interface ReadinessResult {
  ok: boolean;
  database: 'ok' | 'error';
  migrations: 'current' | 'pending' | 'error';
  pendingMigrations: number;
  currentMigration: number | null;
  latestMigration: number | null;
  detail?: string;
}

export async function readiness(): Promise<ReadinessResult> {
  try {
    await pool.query('SELECT 1');
    const status = await getMigrationStatus();
    if (status.pending.length > 0) {
      return {
        ok: false,
        database: 'ok',
        migrations: 'pending',
        pendingMigrations: status.pending.length,
        currentMigration: status.current,
        latestMigration: status.latest,
      };
    }
    return {
      ok: true,
      database: 'ok',
      migrations: 'current',
      pendingMigrations: 0,
      currentMigration: status.current,
      latestMigration: status.latest,
    };
  } catch (error) {
    return {
      ok: false,
      database: 'error',
      migrations: 'error',
      pendingMigrations: -1,
      currentMigration: null,
      latestMigration: null,
      detail: error instanceof Error ? error.message : 'Unknown readiness failure',
    };
  }
}
