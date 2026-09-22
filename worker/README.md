# InternScout Worker

The product's only server: a Cloudflare Worker with a D1 database. It checks Google or Microsoft
sign-in, calls Gemini with the project's key, enforces monthly caps and the global budget, and counts
the states students pick. The request/response contract is in [API.md](API.md).

<!-- was: It stores only hashed IDs, usage counters, chosen states and monthly spend (`schema.sql`). Never -->
<!-- was: It stores only hashed IDs, usage counters, chosen states and spend totals, monthly and daily (`schema.sql`). -->
<!-- "only" was still wrong: schema.sql's `plans` table holds a Stripe customer id, a subscription id
     and a status, and `stripe_events` holds event ids. Those are third-party account identifiers, not
     hashed IDs or counters, and a Web Store reviewer reads this file. schema.sql:73 already says as
     much beside the table; this sentence now matches it. -->
It stores hashed IDs, usage counters, chosen states, spend totals monthly and daily, and -- for a paid
plan -- the Stripe customer and subscription ids and the plan's status (`schema.sql`). Never prompts,
replies, emails or tokens. Workers Logs stay off for the same reason.

## Files

| File | What it does |
|---|---|
| `src/index.js` | Routes, CORS, daily cleanup cron |
| `src/auth.js` | ID token checks (JWKS, `iss`, `aud`, `exp`), `edu`/`general` tier, user hash |
<!-- was: | `src/limits.js` | Monthly allowance, per-minute/day rate limits, budget | -->
| `src/limits.js` | Monthly allowance, per-minute/day rate limits, monthly and daily budget |
| `src/gemini.js` | Builds the Gemini request, clamps tokens and thinking, prices usage |
| `src/demand.js` | `POST /demand` and CI-only `GET /demand` |
| `src/billing.js` | Optional paid plans: Stripe Checkout, the billing portal, webhook checks |
| `src/config.js` | Models, per-task allowances, prices, rate limits. Edit here, then deploy |
| `wrangler.toml` | Public vars (client IDs, origins, budget) and the D1 binding |

## Run locally

Requires Node 20+.

```bash
cd worker
npm install
npm test                  # unit tests (node --test)
npm run test:workers      # vitest inside the Workers runtime
npx wrangler d1 execute internscout --local --file=schema.sql
npm run dev               # http://localhost:8787
```

For `wrangler dev`, put local-only secrets in `worker/.dev.vars` (git-ignored), for example
`HASH_SALT=dev-salt`. Use a test Gemini key there, never the production one.

## Deploy (Bruce)

Claude never handles keys. Run these yourself:

1. `npx wrangler login`
2. Create the database: `npx wrangler d1 create internscout`. Copy the `database_id` it prints into
   `wrangler.toml` (the ID isn't secret).
3. Create the tables: `npx wrangler d1 execute internscout --remote --file=schema.sql`
4. Set the secrets. Each command prompts for the value:
   - `npx wrangler secret put GEMINI_API_KEY` (a paid-tier key, so Google doesn't train on prompts)
   - `npx wrangler secret put HASH_SALT` (any long random string; changing it resets everyone's usage)
   - `npx wrangler secret put DEMAND_TOKEN` (any long random string; CI uses it to read state counts)
5. `npm run deploy`. Note the `*.workers.dev` URL it prints. This applies `schema.sql` to the live
   database first (every statement is `CREATE TABLE IF NOT EXISTS`, so it is safe to repeat) and then
   deploys. Always deploy this way rather than with `wrangler deploy` on its own: a commit that adds a
   table and code that reads it would otherwise ship without the table, and every request that
   touches it would answer 500. That is exactly what happened to `/me` when the billing tables landed.

   <!-- "safe to repeat" is true and incomplete, and the gap only bites on a database that is already
        live -- which is now the case. `CREATE TABLE IF NOT EXISTS` skips a table that exists; it never
        adds a missing COLUMN to one. So a `plans` table created under an older shape survives this step
        untouched, the deploy reports success, and every checkout then fails on the live site with "no
        such column". Nothing in the deploy output says so. Added here because the read-only check costs
        two seconds and the failure it prevents is a student's declined card. -->
   **Before the first deploy after a schema change, read the live shapes and compare them to
   `schema.sql` by eye.** `CREATE TABLE IF NOT EXISTS` adds a missing table but never a missing column,
   so a table that already exists in an older shape is left as it was and the deploy still reports
   success:

   ```
   npx wrangler d1 execute internscout --remote --command "SELECT name, sql FROM sqlite_master WHERE type='table'"
   ```

   A table that is missing entirely will be created by step 5. A table that is present but short a
   column has to be migrated by hand with `ALTER TABLE ... ADD COLUMN`, because nothing in this
   repository will do it for you.
6. Put that URL in `extension/lib/config.js` (`WORKER_URL`) and in the dashboard's `CONFIG.workerUrl`.
7. GitHub repo secrets for the ingest workflow: `INTERNSCOUT_DEMAND_URL` (the Worker URL plus `/demand`)
   and `INTERNSCOUT_DEMAND_TOKEN` (the same value as `DEMAND_TOKEN`).

Check it: `GET <worker-url>/config` should list both providers and `"paused": false`.

## Sign-in providers

Both client IDs are public and live in `wrangler.toml`. A provider is hidden while its ID is empty.

- **Google:** a *Web application* OAuth client. JavaScript origins are the Pages origin and
  `http://localhost:8000`.
- **Microsoft:** the Entra app "InternScout" (any tenant + personal accounts). ID tokens are on,
  with the optional claims `email` and `xms_edov`. For now it targets personal accounts, because an
  unverified publisher can't get consent in most school tenants.

Both need these redirect URIs:
- `https://bpmcginley.github.io/InternshipFinder/`
- `https://jmjjgnckddhjbohfpbekodkpbpbmfjag.chromiumapp.org/`. The `"key"` in `extension/manifest.json`
  gives the store install and every Load unpacked copy this same ID, so one redirect covers both.

<!-- was: ## Paid plans (Bruce, only when AI spend needs covering) -->
## Paid plans (live)

<!-- was: Two tiers, both optional, both dormant until you turn them on: `PAYMENTS_ENABLED = "0"` in -->
<!-- was: `wrangler.toml`, so `/config` says `payments: { enabled: false }`, the dashboard shows no upgrade -->
<!-- was: button and all three `/billing/*` routes return 404. Claude does none of these steps — keys stay -->
<!-- was: with you. -->
Both tiers are switched on and selling (Bruce confirmed 2026-09-19 that they stay on at launch).
`wrangler.toml` carries `PAYMENTS_ENABLED = "1"`, `STRIPE_MANAGED_PAYMENTS = "1"`,
<!-- was: `SUPPORTER_PRICE_TEXT = "$5/month"` and `PRO_PRICE_TEXT = "$12/month"`, so `/config` answers -->
<!-- was: `payments: { enabled: true, plans: [...] }` with those price strings, the dashboard shows the upgrade -->
`SUPPORTER_PRICE_TEXT = "$5/month"` and `PRO_PRICE_TEXT = "$12/month"`, so, with `STRIPE_SECRET_KEY`
and at least one price id also set (the paragraph below, and the other half of the switch),
`/config` answers `payments: { enabled: true, plans: [...] }` with those price strings, the dashboard shows the upgrade
button, and all three billing routes are live: `POST /billing/checkout`, `POST /billing/portal` and
the Stripe-signed `POST /billing/webhook`. That is why the product is no longer free to describe:
copy anywhere that calls InternScout simply free is now wrong.

Two things still gate a tier even with payments on, and both are secrets rather than code: nothing is
offered at all unless `STRIPE_SECRET_KEY` is set, and a tier is offered only while its own price id
(`STRIPE_PRICE_ID` for Supporter, `STRIPE_PRICE_ID_PRO` for Pro) is set. Unsetting one hides that tier
and makes its checkout 404 again, without a deploy.

The steps below are how this was turned on, and how to redo it against a new Stripe account or when
rotating from test keys to live ones. Claude does none of them — keys stay with you.

| Plan | Price | Allowance | Cost if fully used | Left over |
|---|---|---|---|---|
| Free (.edu) | — | 20 Auto-Apply, 10 resumes; Deep Dives uncapped | ~$1.34 | — |
| Supporter | $5/month | 2.5× that | ~$3.35 | ~27% of $4.56 net |
| Pro | $12/month | 6× that | ~$8.04 | ~29% of $11.35 net |

That last column is the worst case, a student who spends every unit; almost nobody does, so the
everyday margin is much wider. The numbers come from about $0.06 per auto-filled application, $0.01
per tailored resume and $0.02 per Deep Dive, minus Stripe's 2.9% + 30¢. A non-.edu account gets
half the allowance for the same price, which also costs half as much to serve.

**From 2027-01-01** Gemini 3.8 Flash doubles in price, so `ALLOWANCE_CHANGES` in `src/config.js`
halves every capped Flash task that day: free .edu becomes 10 Auto-Apply, 5 resumes, and the
paid tiers scale from that (Supporter 25 / 13, Pro 60 / 30). The Deep Dive is a one-off worth a
few cents, so it has no monthly cap (`allowance: null`); only the rate limits and the budget stop
bound it. Field matching and short answers
run on Flash-Lite and keep their allowance. A skipped rules-only application costs no unit, so each
Auto-Apply unit spent is a run that did call the model, at nearer $0.08 than the $0.06 average; at
double price the full-use Supporter comes to about $4.38 of AI against $4.56 net. That margin is thin,
so check the real per-task spend in D1 after launch before the change takes effect. Nothing needs
deploying on the day: the Worker reads the date. It does need deploying once before then.

A tier is offered only when its own Stripe price id is set, so you can launch Supporter alone and add
Pro later without touching code.

1. In Stripe, **test mode first**: create a product per tier ("InternScout Supporter", "InternScout
   Pro") with a recurring monthly price. Copy each price id (`price_…`).
2. Keep price, multiplier and text in step: `src/config.js` `PLANS.<tier>.multiplier` decides what the
   money buys, and `SUPPORTER_PRICE_TEXT` / `PRO_PRICE_TEXT` in `wrangler.toml` are only the text
   students read. Change a Stripe price and you must change these too.
3. Secrets:
   - `npx wrangler secret put STRIPE_SECRET_KEY` (the test `sk_test_…` first)
   - `npx wrangler secret put STRIPE_PRICE_ID` (Supporter)
   - `npx wrangler secret put STRIPE_PRICE_ID_PRO` (Pro; skip it to launch with one tier)
4. Add the webhook in Stripe → Developers → Webhooks: URL `<worker-url>/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `charge.refunded`, `charge.dispute.created`. The last two put a student back on free and cancel
   the subscription when the money goes back; leave them out and a refunded plan keeps its
   allowance. Copy the signing secret and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
5. Set `PAYMENTS_ENABLED = "1"` and a correct `SITE_URL` in `wrangler.toml`, then `npm run deploy`.
6. Check it with a test card (`4242 4242 4242 4242`): `GET /me` should flip to `"plan": "supporter"`
   (or `"pro"`) with a larger allowance, switching tier in Stripe's portal should move it across, and
   cancelling should put it back to `free`.
7. Only then repeat steps 1–5 with the live keys.

**Stripe as merchant of record.** `STRIPE_MANAGED_PAYMENTS = "1"` (the default) asks Stripe to sell
the plans itself under [Managed Payments](https://docs.stripe.com/payments/managed-payments/how-it-works):
it adds and remits the student's local sales tax or VAT, handles disputes and issues the receipts.
Two things must be true first, or Stripe refuses every checkout session: Managed Payments is
activated at `dashboard.stripe.com/settings/managed-payments`, and each product has a tax code marked
"Eligible for Managed Payments" (ours use `txcd_10105003`, AI as a service). Set it to `"0"` to send
plain checkout sessions, where you owe the tax yourself.

To switch them off again, set `PAYMENTS_ENABLED = "0"` and deploy. Existing subscribers keep their plan
row but stop being charged only once you cancel their subscriptions in Stripe, so cancel there too.

## Changing limits

- Allowances, models, prices and rate limits: `src/config.js`, then deploy.
- Global monthly budget: `MONTHLY_BUDGET_CENTS` in `wrangler.toml` ($75). Keep the Google Cloud
  budget alert in step with it. It is the backstop that stops AI before a surprise bill arrives, so
  raise it and a per-student allowance together only once you have real usage numbers.
<!-- was: - What may be spent in one day: `DAILY_BUDGET_CENTS`, as a var or in `src/config.js`. Left `null` it -->
<!-- was:   is a thirtieth of the monthly figure, $2.50 a day at $75, and it moves when the month does. It -->
<!-- was:   exists because the monthly stop is cumulative: without a day's share the whole month can go on -->
<!-- was:   launch day and every student after that finds AI dead until the 1st. A day that runs out answers -->
<!-- was:   `/ai` with 503 `paused` until midnight UTC and leaves search alone; `"0"` turns AI off for today. -->
- What the **free tier** may spend in one day: `DAILY_BUDGET_CENTS`, as a var or in `src/config.js`.
  Left `null` it is a thirtieth of the monthly figure, $2.50 a day at $75, and it moves when the
  month does. It exists because the monthly stop is cumulative: without a day's share the whole
  month can go on launch day and every student after that finds AI dead until the 1st. A day that
  runs out answers `/ai` with 503 `paused` until midnight UTC and leaves search alone; `"0"` turns
  AI off for today. It applies to free accounts only (Bruce, 2026-09-19): a Supporter or Pro student
  has paid for their AI and is bounded by their own `USER_BUDGET_CENTS` row and by the monthly stop,
  so a ceiling free accounts drained never tells a paying student "AI is paused until tomorrow".
  Their spend is not counted against this row at all, which is why it reads as the free tier's share
  of the month rather than the deployment's whole day.
<!-- was: - What one account may cost in a month: `USER_BUDGET_CENTS` in `src/config.js` ($3 free, $4.50 -->
<!-- was:   Supporter, $11 Pro). It sits well above what a full allowance costs, so honest use never meets -->
- What one account may cost in a month: `USER_BUDGET_CENTS` in `src/config.js` ($1.50 free, $4.50
  Supporter, $11 Pro). The free row halved on 2026-09-19 so the same $75 reaches twice as many
  students; at $1.34 for a full free .edu allowance it still sits above honest use, but not far, so
  it is the one row to revisit once real per-student spend is in D1. It is what stops one modified
  client from spending the whole global budget through the
  uncapped Deep Dive. Keep each paid row under what the plan brings in after Stripe's cut.
- Token totals and the cache hit rate for a month:
  `npx wrangler d1 execute internscout --remote --command "SELECT * FROM tokens"` (`cached / prompt`).
- AI calls per minute across everyone: `GLOBAL_RPM`. This is the guard against a busy hour spending
  the whole Gemini per-minute quota, which would answer every student with upstream errors instead
  of turning away only the newest arrivals. Read your account's real number at
  aistudio.google.com/rate-limit and set this under it. `"0"` turns AI off at once.
- Share of the allowance for non-.edu accounts: `GENERAL_ALLOWANCE_PCT`.
- What a paid plan gets: `PLANS.<tier>.multiplier` and `PLANS.<tier>.rate` in `src/config.js`.
  The comment above `PLANS` carries the arithmetic that keeps each price ahead of its own ceiling.
- Extra school domains that don't end in `.edu`: `EDU_EXTRA_DOMAINS`.
- New allowed site origin (for example a custom domain): add it to `ALLOWED_ORIGINS`, and to both
  sign-in providers' redirect URIs.
