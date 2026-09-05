# Database migrations

The production database is changed only through the ordered SQL files in this directory.

## Rules

1. Name files `NNN_description.sql` with a version higher than every existing migration.
2. Never edit, rename or delete a migration after it has been applied anywhere. The runner stores a SHA-256 checksum and refuses drift.
3. Put one logical schema change in each migration and make data backfills explicit.
4. Each migration runs inside a PostgreSQL transaction. Any failure rolls the whole migration back.
5. The runner holds a PostgreSQL advisory lock, so concurrent app instances cannot migrate at the same time.
6. `npm start` runs pending migrations before the HTTP server opens. If migration fails, the app does not start.
7. `npm run db:migrate` applies migrations manually when needed. `npm run db:status` verifies that the database is current and exits non-zero when it is not.
8. Do not fix production schema drift manually in TablePlus. Add a new migration and deploy it.

`001_initial.sql` is intentionally idempotent because it also adopts databases created before the migration ledger existed. Once it is recorded in `schema_migrations`, its checksum becomes immutable like every later migration.
