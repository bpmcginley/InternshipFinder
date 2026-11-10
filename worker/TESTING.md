# Worker tests

Use Node 22, as selected by the shared CI action. Run these commands from `worker/`.
The two suites test different execution environments; keep both green for worker changes.

## Commands

```bash
# Built-in Node runner; no npm dependency install is needed for this suite.
node --test test/
# npm test is the same directory entry point.
npm test

# Pinned local workerd, D1 and Vitest dependencies.
npm ci
npm run test:workers
```

`test/index.js` imports the Node test files explicitly. Add a new Node test there so the directory
entry point used by CI and coverage runs it. A file that passes alone is not enough evidence that
`npm test` includes it. `vitest.config.js` selects `test-workers/**/*.test.js` automatically.

For a focused check:

```bash
node --test test/auth.test.js
npm run test:workers -- test-workers/smoke.test.js
```

After a focused check, run both complete suites when a change affects their shared worker logic,
SQL or schema. CI runs the Node suite, installs dependencies with `npm ci`, then runs the Workers
suite. No local development server is required for either test command.

## What each suite proves

| Location | Execution and isolation | Main purpose |
|---|---|---|
| `test/` | Node's built-in runner and Web APIs; `test/helpers.js` creates a fresh in-memory SQLite database and exposes a D1-shaped adapter | Logic, route responses, auth, quotas, provider failures, billing/order state transitions, metrics and CLI behavior with injected dependencies |
| `test-workers/` | Vitest's Cloudflare plugin executes the worker in local workerd with local D1 bindings | Runtime compatibility, real D1 batch rollback, SQL constraints/triggers, concurrent claims and WebCrypto behavior |
| `test-support/` | Shared scenario code imported by tests | Reuse the same assertions against different database implementations without duplicating the scenario |

The Node suite is not limited to pure functions. Its adapter initializes `schema.sql`, executes real
SQLite statements and serializes batches inside transactions. It is useful for broad, deterministic
coverage, but it does not establish that every D1 API, workerd behavior or deployed configuration
works. Use the runtime suite for those local integration checks. Local workerd and D1 tests do not
verify production configuration, migrations already applied to a live database, provider
entitlements or real provider delivery.

The runtime tests initialize their local schema using the Wrangler SQL parser. Keep that parser:
splitting SQL on semicolons breaks comments and trigger bodies. Migration-equivalence tests belong
in the runtime suite because they exercise the actual local D1 migration helper and ledger.

## Intentional overlap

`test/settlement-race.test.js` and `test-workers/settlement-race.test.js` both call
`test-support/settlement-race.js`. One runs through the Node SQLite adapter and the other through
local D1. Both verify rollback, concurrent settlement, retry idempotence and absence of orphaned
placements. This overlap is deliberate; do not remove either test as a duplicate.

Other runtime cases complement the broader Node regressions: capacity rollback, employer funnel
triggers, campaign-report leases and erasure, student checkout races and recovery, and basic
route/session/profile behavior. Their presence in both suites does not make a test misplaced.

## Isolation and safe verification

- Node helpers supply synthetic environments, generated test signing keys, injected clocks and fake
  fetch responses. Provider failures and webhook events are simulated, not sent to live services.
- Runtime tests use local D1 and synthetic records. Mail bindings and payment-provider calls in
  tested scenarios are doubles; runtime smoke requests target the locally loaded worker.
- Do not add production credentials or load `.dev.vars` to make tests pass. Do not deploy, run remote
  database commands, send actual email, make payments or paid AI calls, or submit applications as a
  verification step.
- Keep sensitive values and raw source snippets out of shared diagnostic logs. A passing local
  suite is not operator approval to change or reconcile production data.

## Coverage

From `worker/`, `npm run test:coverage` runs the existing worker Node, extension and site suites with
the root VM-attribution preload and c8. It emits source-free LCOV and JSON summaries under the
root `coverage/node/`; it does not replace `npm run test:workers` and is not browser or production
coverage. Coverage remains report-only with no minimum threshold.
