# D1 migration preparation (WP-4.1)

This package prepares and tests migrations locally. It does not adopt them in production, deploy a worker, or change `npm run deploy`. Bruce/operator confirmation is required before the separate deployment-script change.

## Baseline and compatibility

`migrations/0001_baseline.sql` copies `schema.sql` at main `182c02ce` exactly: 42 tables, 22 explicit indexes, six triggers, and the account/inviter backfills. Both `order-mail-schema.sql` and `campaign-report-schema.sql` are already included in that schema. There are no duplicate `0002`/`0003` migrations for them. The standalone files remain because existing tests use them.

Do not edit the accepted baseline for later schema changes. Add the next numbered migration and, until the operator-approved deploy transition, preserve the equivalent change in the legacy `schema.sql` path. The local equivalence test must still pass. Coordinate schema ownership before product database work.

## Local proof

Use Node 22 and the committed worker lockfile, from `worker/`:

```sh
npm ci
npm test
npm run test:workers
```

`test-workers/migrations.test.js` uses two extra local D1 bindings, never the production database. One executes `schema.sql` plus the two standalone files; the other uses the installed Cloudflare migration loader/application helpers. Tests compare schema definitions and column/index/foreign-key metadata, seed historical records to check both backfills, exercise capacity/funnel triggers, verify fixed-data reruns, and prove failed migration DDL and its ledger row roll back together. No provider requests, payment operations or email sends are involved.

Wrangler defaults to `migrations/` and the `d1_migrations` ledger. The pinned version is 4.131.2. The local test helper uses the same SQL splitter as Wrangler, including trigger bodies. See the official [migration reference](https://developers.cloudflare.com/d1/reference/migrations/) and [D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/).

## Production adoption: operator only, not performed

The following procedure is documentation, not authorization for an agent to execute remote commands. Do not mark a baseline applied merely because repository tests pass.

1. Coordinate a database-change window. Verify the intended database/account privately and obtain a recoverable backup or Time Travel checkpoint using the operator's approved procedure. Keep exports, private identifiers and account data outside this repository, PRs and CI logs. The commands below use the configured `DB` binding; verify where it resolves before proceeding.
2. Inspect the live `sqlite_schema`, table columns, indexes/constraints and triggers against the tested baseline. Counts alone are insufficient. Verify the two included mail/report tables, all six trigger definitions, and the actual account/inviter backfill state. Repository history proves only the checked-in deploy path, not what production has applied. Stop on any missing/different object or unverified backfill; reconcile through a separately reviewed change instead of recording a false baseline.
3. Inspect any existing `d1_migrations` table and records. If another migration system or unexpected entries exist, stop and reconcile that history first. Do not overwrite, delete or renumber existing records.
4. Only after the schema and data invariants are verified, record **only `0001_baseline.sql`** as already applied. This is a ledger-only adoption of an existing schema, not execution of the baseline against production. The ledger definition below matches pinned Wrangler 4.131.2 and its local test helper:

```sh
npx --no-install wrangler d1 execute DB --remote --command "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) SELECT '0001_baseline.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0001_baseline.sql');"
npx --no-install wrangler d1 execute DB --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY id;"
npx --no-install wrangler d1 migrations list DB --remote
```

5. Verify exactly one baseline record and no unexpected pending migration. Record only the reviewed commit and completion status in `notes/refactor/STATUS.md`, without account identifiers or data. A fresh database needs the actual baseline applied; it must never be initialized by ledger marking alone.
6. Request a separate reviewed deployment-script change only after the recurring-backfill decision below is resolved. This package leaves the existing deployment command untouched.

## Recurring backfills remain an adoption gate

Today `npm run deploy` reruns all of `schema.sql`, including account first-seen and inviter lifetime-count backfills, before each worker deployment. The migration runner applies a named migration once. Merely replacing the deploy command with `migrations apply` would silently remove those recurring operations.

The operator and reviewer must explicitly choose whether to preserve the existing recurring backfill step or approve a demonstrated change to that behavior. Verify how historical usage, demand, plan, invite-code and referral rows are handled; a same-month usage record must not move a genuinely new account back to the month's first day, and inviter lifetime counts must never fall. The local ledger test deliberately demonstrates that a later usage row is not backfilled when an already-recorded baseline is reapplied. No deployment-script change is permitted until this difference is resolved.

If adoption is incomplete or uncertain, keep the current deployment process. Do not run an unreviewed repair, erase migration history, or treat a code revert as a database rollback. Production repair and deployment remain operator-owned.
