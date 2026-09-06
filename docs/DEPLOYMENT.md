# Adam Financial Book — Production Deployment Runbook

## Production contract

Production must run Node 22+, `NODE_ENV=production`, verified PostgreSQL TLS, and a `SESSION_SECRET` of at least 32 characters. `DATABASE_URL` and `SESSION_SECRET` are mandatory. Startup validates configuration before opening database connections.

## Deploy sequence

Render builds with:

```sh
npm ci && npm run typecheck && npm test -- --passWithNoTests && npm run build
```

Render starts with:

```sh
npm start
```

`npm start` performs these gates in order:

1. validate environment configuration;
2. open the database connection;
3. acquire the migration advisory lock;
4. apply pending migrations transactionally;
5. verify that no migrations remain pending and no historical migration has drifted;
6. log the release SHA and schema version;
7. open the HTTP server.

If any gate fails, the application does not open for traffic.

## Health/readiness

Render must use `/api/health/ready` as the service health-check path. It verifies PostgreSQL connectivity and that the schema has no pending migrations. `/api/health/live` is the process-only liveness endpoint.

The independent production monitor also calls `/api/health/ready` every ten minutes and verifies all of these fields before treating production as healthy:

- HTTP 2xx;
- `ok: true`;
- `database: "ok"`;
- `migrations: "current"`;
- `pendingMigrations: 0`.

For explicit schema diagnostics, run:

```sh
npm run db:status
```

A healthy deployment has zero pending migrations and `current === latest`.

## Pre-deploy verification

Before merging or manually deploying:

```sh
npm ci
npm run verify
```

`npm run verify` runs typecheck, tests, and the production Vite build. The integration workflow additionally runs migrations twice, API integration, the encrypted backup/restore drill, financial end-to-end reconciliation, and the final database-integrity certification against disposable PostgreSQL.

## Required Render environment

- `DATABASE_URL` — pooled Neon PostgreSQL URL.
- `SESSION_SECRET` — generated random value, at least 32 characters.
- `BACKUP_ENCRYPTION_KEY` — stable value of at least 32 characters. Do not rotate without preserving the old key for old archives.
- `NODE_ENV=production`.
- `NODE_VERSION=22`.
- `PGSSL=verify`.
- `PGPOOL_MAX=8` unless capacity testing shows a need to change it.

Optional integrations:

- `ANTHROPIC_API_KEY`
- `GOOGLE_TRANSLATE_API_KEY`
- `REPORT_TO`
- `REPORT_FROM`
- `SMTP_URL`
- `ALERT_WEBHOOK_URL`

Secrets must never be committed to the repository or printed in application logs.

## Recovery certification

The repository contains a destructive-safety restore drill in `server/recovery.integration.test.ts`. It never restores over the source database. The drill:

1. creates an authenticated AES-256-GCM `.afb` backup;
2. creates a brand-new disposable PostgreSQL database;
3. migrates the disposable target;
4. restores all application tables and binary attachments;
5. verifies every restored table row count;
6. verifies attachment bytes exactly;
7. verifies migrations are current;
8. verifies sequence reseeding by performing a post-restore insert;
9. runs the full accounting/data integrity checker;
10. rejects a deliberately tampered encrypted backup.

`server/restore.ts` requires `RESTORE_DATABASE_URL` and refuses to restore over `DATABASE_URL` unless the explicit emergency override `ALLOW_PRODUCTION_RESTORE=1` is present.

## Rollback procedure

Application rollbacks and database rollbacks are intentionally different.

### Safe application rollback

1. Identify the last known-good Git commit/deploy in Render deploy history.
2. Redeploy that known-good revision.
3. Do not delete rows from `schema_migrations`.
4. Verify `/api/health/ready` returns HTTP 2xx, `database=ok`, `migrations=current`, and zero pending migrations.
5. Verify the independent production health monitor is green.
6. Smoke-test sign-in and a read-only account view before resuming normal use.

Forward-compatible migrations should be preferred so the previous application release can still operate after a schema migration.

### Schema rollback

Do not edit an already-applied migration and do not manually remove its migration ledger row. If a schema change must be reversed, create a new higher-numbered migration that performs the corrective change. This preserves an auditable history and checksum integrity.

### Data recovery

Use a recent encrypted `.afb` archive and always restore it to a disposable database first:

```sh
DATABASE_URL='postgres://production-or-source' \
RESTORE_DATABASE_URL='postgres://disposable-recovery-db' \
BACKUP_ENCRYPTION_KEY='stable-production-backup-key' \
npm run restore -- backups/adam-financial-book-....afb
```

Only consider an emergency production restore after the disposable restore reports `restore.verified` with zero integrity errors and current migrations.

## Failed deploy handling

If startup fails:

1. inspect the first `startup.validation` or migration error in logs;
2. correct the environment variable or create a forward migration as appropriate;
3. redeploy;
4. never bypass migration checks by starting `server/index.ts` directly in production.

## Release verification

Every production startup emits structured JSON events containing the runtime mode, Node version, service name, release SHA, and current/latest migration version. Use those entries together with the Render deploy history and the independent GitHub production monitor to prove which application release and schema version are running together.

## Manual database changes

Normal feature deployments must not require TablePlus SQL. Schema changes belong in a new file under `server/migrations/` and deploy with the application. Emergency manual changes should only be used for incident recovery and must be represented afterward by a migration so production state and repository history converge again.
