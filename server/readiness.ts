import { pool } from './db.js';
import { migrationStatus } from './migrate.js';

export interface ReadinessResult {
  ok: boolean;
  database: 'ok' | 'error';
  migrations: 'current' | 'pending' | 'error';
  pendingMigrations: number;
  detail?: string;
}

export async function readiness(): Promise<ReadinessResult> {
  try {
    await pool.query('SELECT 1');
    const status = await migrationStatus();
    if (status.pending.length > 0) {
      return {
        ok: false,
        database: 'ok',
        migrations: 'pending',
        pendingMigrations: status.pending.length,
      };
    }
    return { ok: true, database: 'ok', migrations: 'current', pendingMigrations: 0 };
  } catch (error) {
    return {
      ok: false,
      database: 'error',
      migrations: 'error',
      pendingMigrations: -1,
      detail: error instanceof Error ? error.message : 'Unknown readiness failure',
    };
  }
}
