# Recovery and launch checks

Checked October 20, 2026. This supplements ORDERS.md; it does not authorize a live
restore, payment, refund, claim reset or test employer order.

## Before a deployment

1. Use a clean reviewed source commit. Preserve every plain Wrangler variable and existing
   secret; confirm EMPLOYER_CHECKOUT and EMAIL agree with the intended launch state.
2. Run `npm test` and `npm run test:workers` from worker/. These use synthetic providers and
   local databases. The orders suite exercises approval/refusal, delayed payment, disputes,
   duplicate events, uncertain refunds/credits and capacity; local Workers tests exercise real
   D1 batch rollback. They do not establish live Stripe or email delivery.
3. Record the deployed Worker version and read-only D1 Time Travel bookmark privately:
   `npx wrangler d1 time-travel info internscout --json`. Do not copy private data into Actions,
   GitHub issues or the public site. Record the source commit and deploy time alongside it.
4. After deploy, read `/config`, `/employer/config`, the site role index and the public buy page.
   Verify a normal Origin/User-Agent if Cloudflare rejects a generic command-line client.
   Do not create a real order or force a broadcast/post just to prove a deployment worked.

## Database recovery

D1 Time Travel is always on for production databases; the existing Paid plan provides up to
30 days. See [Cloudflare's recovery documentation](https://developers.cloudflare.com/d1/reference/time-travel/).
Verify bookmark availability for the needed timestamp before choosing any recovery point.
Database recovery is separate from reverting Worker code or a Pages deployment.

On October 20, the owner-authenticated CLI returned a current bookmark. A schema-only remote
export was imported into a fresh, isolated in-memory SQLite database: 41 tables, one trigger,
integrity check `ok`, zero foreign-key violations. Evidence remains outside the repository in
the owner's execution receipts folder. No production rows were copied or database restored.
This proves schema portability, not a complete data-recovery drill or successful D1 Time Travel
restore. Do not describe it as a full backup or disaster-recovery test.

For an actual incident:

1. Identify whether the fault is code, data, an external provider outcome or a delayed job.
   Reverting code cannot undo a Stripe charge; restoring D1 cannot undo a refund or email.
2. Before any destructive restore, stop new writes and account for payable Checkout sessions,
   queued mail, in-flight requests and provider operations. Coordinate a maintenance window.
3. Preserve the current bookmark and private reconciliation evidence; choose a timestamp with
   a timezone. A D1 restore overwrites the database and cancels in-flight queries.
4. Review the exact restore with the owner, including records that would be lost. The
   `wrangler d1 time-travel restore` command is deliberately not run by a health check.
5. After recovery, reconcile Stripe events and payment/refund/credit references before
   resuming writes. Restore neither old claims nor old outbox entries blindly: they can
   repeat external effects. Follow ORDERS.md for unknown financial operations.

## Daily operations

- Inspect failed ingest, Pages, digest and Brand posts runs; distinguish skipped, degraded
  fallback and unknown from success. Never force a retry until provider state is known.
- Check unresolved employer decisions/credit jobs and unsent outbox entries using the
  read-only queries in ORDERS.md. Owner alerts run on the daily cron, not every 15 minutes.
- Keep pilot codes private. Allocate one per first employer buyer through site checkout.
  Draft, pause, end and refuse remain available; manual activation/update is blocked while
  self-serve checkout is on.
- Exact-package extension authentication/update checks remain separate release gates.
  Keep Node/Wrangler/Vitest tooling maintenance separate from a production emergency change.
