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

Render uses `/api/health`. The route checks PostgreSQL with `SELECT 1`. Because the HTTP server is only opened after migration validation succeeds, this endpoint acts as both the production liveness and readiness check: a process cannot report healthy while its schema is behind the code.

For explicit schema diagnostics, run:

```sh
npm run db:status
```

A healthy deployment has zero pending migrations.

## Pre-deploy verification

Before merging or manually deploying:

```sh
npm ci
npm run verify
```

`npm run verify` runs typecheck, tests, and the production Vite build.

## Required Render environment

- `DATABASE_URL` — pooled Neon PostgreSQL URL.
- `SESSION_SECRET` — generated random value, at least 32 characters.
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

Secrets must never be committed to the repository or printed in application logs.

## Rollback procedure

Application rollbacks and database rollbacks are intentionally different.

### Safe application rollback

1. Identify the last known-good Git commit/deploy.
2. Redeploy that commit through Render.
3. Do not delete rows from `schema_migrations`.
4. Verify `/api/health` and `npm run db:status`.
5. Smoke-test sign-in and a read-only account view before resuming normal use.

Forward-compatible migrations should be preferred so the previous application release can still operate after a schema migration.

### Schema rollback

Do not edit an already-applied migration and do not manually remove its migration ledger row. If a schema change must be reversed, create a new higher-numbered migration that performs the corrective change. This preserves an auditable history and checksum integrity.

## Failed deploy handling

If startup fails:

1. inspect the first `startup.validation` or migration error in logs;
2. correct the environment variable or create a forward migration as appropriate;
3. redeploy;
4. never bypass migration checks by starting `server/index.ts` directly in production.

## Release verification

Every production startup emits structured JSON events containing the runtime mode, Node version, service name, release SHA, and current/latest migration version. Use those entries to prove which application release and schema version are running together.

## Manual database changes

Normal feature deployments must not require TablePlus SQL. Schema changes belong in a new file under `server/migrations/` and deploy with the application. Emergency manual changes should only be used for incident recovery and must be represented afterward by a migration so production state and repository history converge again.
