# Phase 9 — Backup, Recovery + Observability

Phase 9 makes Adam Financial Book both recoverable and observable in production.

## Backup model

The primary database remains PostgreSQL. Backups are full logical snapshots of the application tables, not only the visible ledger export. Every table is read inside one PostgreSQL `REPEATABLE READ READ ONLY` transaction so the archive represents one consistent point in time.

The snapshot is JSON, compressed with gzip, then authenticated and encrypted with AES-256-GCM. The encryption key is derived from `BACKUP_ENCRYPTION_KEY` with scrypt and a random salt. Every backup also has a SHA-256 checksum and each table has its own logical row checksum. `BYTEA` attachments are preserved as base64 inside the encrypted payload and converted back to binary during restore.

The encrypted file extension is `.afb`. The file does not contain the encryption key.

### Automatic production backup

`render.yaml` defines `adam-financial-book-encrypted-backup`, scheduled daily at 01:30 UTC. The job uses the same generated `BACKUP_ENCRYPTION_KEY` as the web service and delivers the encrypted archive through the already-configured report SMTP transport. The latest run is recorded in `backup_runs` and appears in the owner's Setup → Backup & recovery panel.

The mail attachment limit defaults to 18 MiB (`BACKUP_MAX_EMAIL_BYTES`). A backup that cannot be created or delivered fails loudly and triggers the operational alert path. If the encrypted archive grows beyond the mail provider's attachment capacity, move the scheduled destination to object storage rather than silently lowering coverage.

### Manual backup

Owners can use **Setup → Backup & recovery → Download encrypted backup**. The API returns an encrypted `.afb` file and records its backup ID, checksum, size and migration version.

For command-line archives:

```sh
npm run backup -- backups
```

Local `.afb` files are created mode `0600`. `BACKUP_RETENTION_DAYS` defaults to 30 for that local archive directory.

## Encryption-key rule

`BACKUP_ENCRYPTION_KEY` must be at least 32 characters and must remain stable. Losing it means losing the ability to restore old backups. Keep a copy somewhere separate from the database, application repository and backup files. Render's Blueprint generates the production value once and securely shares that value with the scheduled backup job.

## Restore runbook

A recovery drill or real recovery should restore into a separate database first:

```sh
DATABASE_URL='postgres://production-or-source' \
RESTORE_DATABASE_URL='postgres://disposable-recovery-db' \
BACKUP_ENCRYPTION_KEY='the-stable-backup-key' \
npm run restore -- backups/adam-financial-book-....afb
```

The restore command deliberately refuses to write to the same URL as `DATABASE_URL`. An emergency in-place restore requires the explicit `ALLOW_PRODUCTION_RESTORE=1` override.

The restore process:

1. decrypts and authenticates the `.afb` archive;
2. verifies every table checksum;
3. applies the current codebase's migrations to the restore target;
4. rejects backups created by a newer schema than the running code;
5. truncates and repopulates the application tables in one transaction;
6. restores binary attachments;
7. reseeds owned PostgreSQL sequences so future inserts cannot collide;
8. runs the full accounting/data integrity checker;
9. verifies the restored database is on the latest migration.

CI performs this same backup → disposable PostgreSQL → restore → integrity verification flow on Phase 9 and future changes.

## Health and observability

Public health endpoints are intentionally minimal:

- `/api/health/live` proves the process can answer HTTP.
- `/api/health/ready` proves PostgreSQL is reachable and the database has no pending migrations. Render uses this path for deploy/routing health checks.

Detailed operational state is owner-only at `/api/operations/status` and in **Setup → Backup & recovery**. It includes database latency and connection-pool pressure, current/latest migration, latest backup and age, API request count/p95/max latency and 5xx count, process memory, failed sign-ins over the last 24 hours, and persisted warning/error/critical event counts.

Authenticated API requests receive an `X-Request-Id`. Slow requests and server errors are emitted as structured JSON logs. Repeated 5xx responses trigger a critical alert. Dropped PostgreSQL connections, migration failures, backup failures and translation-provider/cache failures are logged through the same operational path.

## External monitor

`render.yaml` defines `adam-financial-book-health-monitor`, running every 10 minutes outside the web process. It calls the web service's `/api/health/ready` endpoint. Because the check runs in a separate Render cron service, it can detect the web service or database being unavailable even when the application itself cannot send an alert.

Alerts use either `ALERT_WEBHOOK_URL` or the existing SMTP transport (`SMTP_URL` + `ALERT_TO`/`ALERT_FROM`). The Blueprint reuses the configured day-report SMTP credentials and recipient. Render's own health-check/deploy notifications remain a second independent signal for failed deploys and unhealthy instances.

## Operational event retention

`operational_events` is intentionally small metadata, never passwords, session tokens, cookies or database/SMTP secrets. It is not included in encrypted business-data snapshots because it describes the running environment rather than the financial book. The same is true of `backup_runs` and `schema_migrations`; the restore target recreates those from migrations and future operations.
