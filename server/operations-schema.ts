import { query } from './db.js';

let ready: Promise<void> | null = null;

export async function ensureOperationsSchema() {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS backup_runs (
          id                TEXT PRIMARY KEY,
          started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at      TIMESTAMPTZ,
          status            TEXT NOT NULL CHECK (status IN ('running','success','failed')),
          destination       TEXT NOT NULL,
          bytes             BIGINT,
          checksum          CHAR(64),
          migration_version BIGINT,
          encrypted         BOOLEAN NOT NULL DEFAULT true,
          error             TEXT,
          delivered_at      TIMESTAMPTZ,
          delivery_ref      TEXT,
          artifact_digest   TEXT,
          retention_until   TIMESTAMPTZ
        )
      `);
      await query('ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ');
      await query('ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS delivery_ref TEXT');
      await query('ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS artifact_digest TEXT');
      await query('ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ');
      await query('CREATE INDEX IF NOT EXISTS backup_runs_started_idx ON backup_runs (started_at DESC)');
      await query('CREATE INDEX IF NOT EXISTS backup_runs_status_idx ON backup_runs (status, started_at DESC)');
      await query(
        'CREATE INDEX IF NOT EXISTS backup_runs_delivery_idx ON backup_runs (destination, delivered_at DESC)',
      );
      await query(`
        CREATE TABLE IF NOT EXISTS operational_events (
          id          TEXT PRIMARY KEY,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          severity    TEXT NOT NULL CHECK (severity IN ('info','warn','error','critical')),
          event       TEXT NOT NULL,
          request_id  TEXT,
          detail      JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await query('CREATE INDEX IF NOT EXISTS operational_events_created_idx ON operational_events (created_at DESC)');
      await query('CREATE INDEX IF NOT EXISTS operational_events_event_idx ON operational_events (event, created_at DESC)');
      await query('CREATE INDEX IF NOT EXISTS operational_events_severity_idx ON operational_events (severity, created_at DESC)');
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  await ready;
}
