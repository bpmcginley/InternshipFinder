# D1 migrations and Worker deployment (WP-4.1)

The Product release lead verified the baseline against production and confirmed the single baseline ledger entry before the deploy script changed. The coordinated release lead runs production deployments.

## Baseline and compatibility

`migrations/0001_baseline.sql` copies `schema.sql` at main `182c02ce` exactly: 42 tables, 22 explicit indexes, six triggers, and the account/inviter backfills. Both `order-mail-schema.sql` and `campaign-report-schema.sql` are already included in that schema. There are no duplicate `0002`/`0003` migrations for them. The standalone files remain because existing tests use them.

Do not edit the accepted baseline for later schema changes. Add the next numbered migration and keep the legacy `schema.sql` comparison fixture aligned while the local equivalence test uses it. Coordinate schema ownership before product database work.

## Local proof

Use Node 22 and the committed worker lockfile, from `worker/`:

```sh
npm ci
npm test
npm run test:workers
```

`test-workers/migrations.test.js` uses two extra local D1 bindings, never the production database. One executes `schema.sql` plus the two standalone files; the other uses the installed Cloudflare migration loader/application helpers. Tests compare schema definitions and column/index/foreign-key metadata, seed historical records to check both backfills, exercise capacity/funnel triggers, verify fixed-data reruns, and prove failed migration DDL and its ledger row roll back together. A separate local D1 test checks that `deploy-backfills.sql` contains the two exact legacy statements, works on a fresh migrated database, and matches legacy replay when historical rows appear after the baseline is recorded. No provider requests, payment operations or email sends are involved.

Wrangler defaults to `migrations/` and the `d1_migrations` ledger. The pinned version is 4.131.2. The local test helper uses the same SQL splitter as Wrangler, including trigger bodies. See the official [migration reference](https://developers.cloudflare.com/d1/reference/migrations/) and [D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/).

## Adopting another existing database

The coordinated release lead uses this procedure for a verified existing schema when marking the baseline without running its SQL. A fresh database needs the actual baseline applied. Repository tests alone cannot establish an existing database's schema or history.

1. Coordinate a database-change window. Verify the intended database/account privately and obtain a recoverable backup or Time Travel checkpoint using the operator's approved procedure. Keep exports, private identifiers and account data outside this repository, PRs and CI logs. The commands below use the configured `DB` binding; verify where it resolves before proceeding.
2. Inspect the live `sqlite_schema`, table columns, indexes/constraints and triggers against the tested baseline. Counts alone are insufficient. Verify the two included mail/report tables, all six trigger definitions, and the actual account/inviter backfill state. Repository history proves only the checked-in deploy path, not what production has applied. Stop on any missing/different object or unverified backfill; reconcile through a separately reviewed change instead of recording a false baseline.
3. Inspect any existing `d1_migrations` table and records. If another migration system or unexpected entries exist, stop and reconcile that history first. Do not overwrite, delete or renumber existing records.
4. Only after the schema and data invariants are verified, record **only `0001_baseline.sql`** as already applied. This is a ledger-only adoption of an existing schema, not execution of the baseline against production. The ledger definition below matches pinned Wrangler 4.131.2 and its local test helper:

```sh
npx --no-install wrangler d1 execute DB --remote --command "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) SELECT '0001_baseline.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0001_baseline.sql');"
npx --no-install wrangler d1 execute DB --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY id;"
npx --no-install wrangler d1 migrations list DB --remote
```

5. Verify exactly one baseline record and no unexpected pending migration. Record the reviewed commit and completion status in `notes/refactor/STATUS.md` without account identifiers or data.

## Deployment sequence

`npm run deploy` applies pending numbered migrations to the configured database, runs `deploy-backfills.sql` against that same database, then deploys the Worker. A failure in either database step prevents the Worker deployment.

Named migrations run once. The recurring step preserves the two statements previously replayed with `schema.sql`. The account statement uses earlier evidence from usage, demand, plans and invite codes. Usage from the account's first-seen month leaves that timestamp intact. The inviter statement uses rewarded referrals that still name an inviter and only raises the lifetime count. Both statements are idempotent.

Before a production release, confirm the target and expected pending migrations, retain a recoverable database checkpoint, and record the previous Worker release privately. If a database step fails, inspect the ledger and database before retrying. A successful earlier migration can remain applied. A Worker rollback restores code. Database recovery uses the approved checkpoint or a separately reviewed repair, and preserves migration history.
