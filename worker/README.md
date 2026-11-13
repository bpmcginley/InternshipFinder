# InternScout Worker

<!-- was: The product's only server: a Cloudflare Worker with a D1 database. It checks Google or Microsoft
sign-in, calls Gemini with the project's key, enforces monthly caps and the global budget, and counts
the states students pick. -->
The product's only server: a Cloudflare Worker with a D1 database. It checks Google or Microsoft
sign-in and keeps students signed in with sessions, calls Gemini with the project's key, enforces
monthly caps and the global budget, counts the states students pick, and keeps an encrypted copy of a
student's Deep Dive when they save it to their account. The request/response contract is in [API.md](API.md).

<!-- was: It stores only hashed IDs, usage counters, chosen states and monthly spend (`schema.sql`). Never -->
<!-- was: It stores only hashed IDs, usage counters, chosen states and spend totals, monthly and daily (`schema.sql`). -->
<!-- "only" was still wrong: schema.sql's `plans` table holds a Stripe customer id, a subscription id
     and a status, and `stripe_events` holds event ids. Those are third-party account identifiers, not
     hashed IDs or counters, and a Web Store reviewer reads this file. schema.sql:73 already says as
     much beside the table; this sentence now matches it. -->
<!-- was: It stores hashed IDs, usage counters, chosen states, spend totals monthly and daily, and -- for a paid
plan -- the Stripe customer and subscription ids and the plan's status (`schema.sql`). -->
<!-- was: It stores hashed IDs and the day each was first seen, usage counters, chosen states, spend totals
monthly and daily, invite records (a random code, who joined through whose invite as hashed IDs, and
extra units), and -- for a paid plan -- the Stripe customer and subscription ids and the plan's status
(`schema.sql`). Never prompts, -->
<!-- The `inviters` table (each inviter's lifetime count of rewarded invites) was added 2026-09-25 so
     "Delete my data" can't reset the 10-invite cap; it is a hashed ID and a number, listed here like
     the rest. -->
<!-- was: It stores hashed IDs and the day each was first seen, usage counters, chosen states, spend totals
monthly and daily, invite records (a random code, who joined through whose invite as hashed IDs, each
inviter's lifetime count of rewarded invites, and extra units), and -- for a paid plan -- the Stripe
customer and subscription ids and the plan's status (`schema.sql`). Never prompts,
replies, emails or tokens. Workers Logs stay off for the same reason. -->
<!-- Sessions and saved profiles were added 2026-09-26 ("stay signed in" and "save the Deep Dive to your
     account"). -->
It stores hashed IDs and the day each was first seen, usage counters, chosen states, spend totals
monthly and daily, invite records (a random code, who joined through whose invite as hashed IDs, each
inviter's lifetime count of rewarded invites, and extra units), one row per signed-in device (a
sha256 fingerprint of its session token, the tier, the provider and dates), the Deep Dive of each
student who saves it to their account (AES-GCM encrypted under the `PROFILE_KEY` secret, without
files, saved logins, API keys or demographic answers), and -- for a paid plan -- the Stripe customer
and subscription ids and the plan's status (`schema.sql`). Never prompts, replies, emails or tokens.
Workers Logs stay off for the same reason.

## Files

| File | What it does |
|---|---|
| `src/index.js` | Routes, CORS, daily cleanup cron (which also ends placements on their end day) |
| `src/auth.js` | ID token checks (JWKS, `iss`, `aud`, `exp`), `edu`/`general` tier, user hash; hands `iss_` bearers to `session.js` |
| `src/session.js` | "Stay signed in": `POST`/`DELETE /session`, session bearers, the sliding year, 20 per account |
| `src/profile.js` | The saved Deep Dive: `GET`/`PUT`/`DELETE /profile`, AES-GCM at rest, the stale rule |
<!-- was: | `src/limits.js` | Monthly allowance, per-minute/day rate limits, budget | -->
| `src/limits.js` | Monthly allowance, per-minute/day rate limits, monthly and daily budget |
| `src/gemini.js` | Builds the Gemini request, clamps tokens and thinking, prices usage |
| `src/demand.js` | `POST /demand` and CI-only `GET /demand` |
| `src/billing.js` | Optional paid plans: Stripe Checkout, the billing portal, webhook checks |
| `src/referral.js` | Referral credits: invite codes, `GET /invite`, `POST /invite/claim`, extra units |
| `src/placements.js` | Paid listings: public `GET /placements`, the admin routes, the daily auto-end |
| `src/orders/` | Paid listings bought on the site: the order, email link, field cap, Checkout, review page, credits, daily cron (`ORDERS.md`) |
| `src/mail.js` | Plain-text email over the Cloudflare Email Sending binding `EMAIL` (orders only) |
| `scripts/placement.mjs` | Bruce's command line for the placement admin routes, plus `orders` and `pilot-code` (token from the environment) |
| `src/config.js` | Models, per-task allowances, prices, rate limits. Release via [Deploy](#deploy-bruce) |
| `wrangler.toml` | Public vars (client IDs, origins, budget) and the D1 binding |

## Run locally

Use Node 22, matching CI. The Node tests use the built-in `node:sqlite` module and the pinned
test-only API contract parser, so install dependencies before running either suite.

```bash
cd worker
npm ci
npm test                  # Node tests, including an in-memory SQLite D1 adapter
npm run test:workers      # Vitest inside workerd with local D1
npx wrangler d1 execute internscout --local --file=schema.sql
npm run dev               # http://localhost:8787
```

See [TESTING.md](TESTING.md) for focused commands, test isolation and the intentional overlap
between the Node and Workers-runtime suites. Tests use synthetic data and provider doubles; they do
not require production credentials or a deployment.

For `wrangler dev`, put local-only secrets in `worker/.dev.vars` (git-ignored), for example
`HASH_SALT=dev-salt`. Use a test Gemini key there, never the production one.

## Deploy (Bruce)

Claude never handles keys. Run these yourself:

1. `npx wrangler login`
2. For a new installation only, create the database with `npx wrangler d1 create internscout` and
   configure its binding in `wrangler.toml`. Preserve the existing binding on a deployed installation.
3. Review the exact release's ordered files in `migrations/` and the live migration ledger. Do not
   initialize or upgrade a deployed database by executing `schema.sql`; it is the legacy parity
   reference. Apply only the migration set approved for this release.
4. Set the secrets. Each command prompts for the value:
   - `npx wrangler secret put GEMINI_API_KEY` (a paid-tier key, so Google doesn't train on prompts)
   - `npx wrangler secret put HASH_SALT` (any long random string; changing it resets everyone's usage)
   - `npx wrangler secret put DEMAND_TOKEN` (any long random string; CI uses it to read state counts)
   - `npx wrangler secret put ADMIN_TOKEN` (any long random string; only for paid listings, see "Paid
     listings" below. Until it is set, the admin routes answer 404)
   - `npx wrangler secret put PROFILE_KEY` (exactly 32 random bytes, base64: paste the output of
     `openssl rand -base64 32`, or of
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). It encrypts the
     Deep Dives students save to their account. Until it is set, saving is off (`/config` says
     `"sync": false`) and nothing breaks. Set it once and keep it: a new value makes every saved copy
     unreadable until that student saves again.
5. Check pending migrations before choosing the deployment command:

   ```powershell
   npx wrangler d1 migrations list internscout --remote
   ```

   The `deploy` script in `package.json` runs `wrangler d1 migrations apply internscout --remote`,
   then `deploy-backfills.sql`, then `wrangler deploy`. It applies **all pending migrations** from
   the checked-out release. It does not execute `schema.sql`, and it is not a code-only or
   configuration-only deployment command.

   Run `npm run deploy` only when the entire pending set and backfills are approved. If a migration
   is held for another package, stop and use the coordinated release procedure for the exact approved
   code and existing schema. Do not apply the held migration merely to deploy unrelated code.
   The package script deploys immediately after the database steps pass. When the release requires
   ledger and schema verification before promotion, use a coordinated split procedure that stops
   after the approved database steps, verifies them, and only then promotes the exact Worker.
   Preserve a compatible prior Worker version and its bindings for rollback. A Worker rollback
   does not undo D1 migrations.
   Repair schema drift through a reviewed migration, not an ad hoc manual `ALTER TABLE`.

6. Use the verified deployed Worker URL in the extension and dashboard configuration.
7. GitHub repo secrets for the ingest workflow: `INTERNSCOUT_DEMAND_URL` (the Worker URL plus `/demand`)
   and `INTERNSCOUT_DEMAND_TOKEN` (the same value as `DEMAND_TOKEN`).

Check it: `GET <worker-url>/config` should list both providers and `"paused": false`.

## Sign-in providers

Both client IDs are public and live in `wrangler.toml`. A provider is hidden while its ID is empty.

- **Google:** a *Web application* OAuth client. JavaScript origins are `https://internscout.org`, the
  old Pages origin and `http://localhost:8000`.
- **Microsoft:** the Entra app "InternScout" (any tenant + personal accounts). ID tokens are on,
  with the optional claims `email` and `xms_edov`. For now it targets personal accounts, because an
  unverified publisher can't get consent in most school tenants.

Both need these redirect URIs:
- `https://internscout.org/`: the dashboard. It sends `location.origin + location.pathname`, so the
  trailing slash matters; `https://internscout.org` without it does not match.
- `https://bpmcginley.github.io/InternshipFinder/`: the dashboard's address before the domain. GitHub
  Pages now redirects it to `internscout.org`, so this one can be removed once nothing uses it.
- `https://jmjjgnckddhjbohfpbekodkpbpbmfjag.chromiumapp.org/`: every Load unpacked copy. The `"key"` in
  `extension/manifest.json` fixes this ID.
- `https://hpnbbpmalfjijnmpoihhjgjolhabjpgi.chromiumapp.org/`: the Chrome Web Store copy. The store zip
  drops `"key"`, so the store assigned its own ID when the item was created; the key does not carry over.
  Both IDs are also in `ALLOWED_ORIGINS` (`wrangler.toml`).

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
and makes its checkout 404 again once the updated binding configuration is live.

The steps below are how this was turned on, and how to redo it against a new Stripe account or when
rotating from test keys to live ones. Claude does none of them — keys stay with you.

Recalibrated 2026-09-30, after the Auto-Apply cost cuts brought an application from about 6.6¢ to
about 2¢ (measured over 86 recorded steps; planned at 3¢ to leave room for longer Workday forms).

Repriced the same day to volumes students actually apply at, with lower prices and no cut on
2027-01-01:

| Plan | Price | Allowance (.edu), now and after 2027-01-01 | Spending ceiling (`USER_BUDGET_CENTS`) | Kept at full use (2027) |
|---|---|---|---|---|
| Free | — | 25 Auto-Apply, 10 resumes; Deep Dives uncapped | $1.50 | — |
| Supporter | $4/month | 2× that: 50 Auto-Apply, 20 resumes | $2.68 | 33% of $3.58 net (never under 25%) |
| Pro | $8/month | 4× that: 100 Auto-Apply, 40 resumes | $5.60 | 36% of $7.47 net (never under 25%) |

(Was: Supporter $5 at 2.5× and Pro $12 at 6× of 20 Auto-Apply, halving on 2027-01-01.)

The ceiling is what protects the margin. A paid student's AI stops for the month when they reach their
row, whatever an application turned out to cost, and each paid row is 75% of what the plan brings in
after Stripe's 2.9% + 30¢. So a paid month keeps at least a quarter of its money even for a student who
uses everything, and almost nobody does. The allowances are sized to fit under the rows at the planned
costs in `COSTS` (`src/config.js`): about 2¢ an application now and 4¢ after Flash doubles in price on
2027-01-01, 1¢ and 2¢ a tailored resume, 2¢ and 4¢ a Deep Dive. A student therefore meets the allowance
first; the ceiling only stops an unusually expensive month. A non-.edu account gets half the allowance
for the same price.

**On 2027-01-01** nothing changes: the allowances already fit every ceiling at the doubled price, so
`ALLOWANCE_CHANGES` is empty (it still works if a future price change needs a dated cut). The Deep Dive
has no monthly cap (`allowance: null`); the rate limits and the ceiling bound it. Field matching and
short answers run on Flash-Lite and keep their allowance.

Check `task_tokens` in D1 (cents per task and model) after a few weeks: if an application costs well
under 2¢, the allowances can go up; if it costs more, lower them. Neither changes the margin, only how
often a student meets the ceiling before the allowance. Changing a price means creating a new Stripe price and updating the matching
secret (`STRIPE_PRICE_ID`, `STRIPE_PRICE_ID_PRO`), `PLANS` and the `*_PRICE_TEXT` vars together (step 2
below). Follow the [deployment procedure](#deploy-bruce).

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
   allowance. This is the subscription setup list, not the complete top-up event list. Preserve
   existing employer and subscription events when adding the top-up families below. Copy the
   endpoint's signing secret and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
5. Set `PAYMENTS_ENABLED = "1"` and a correct `SITE_URL` in `wrangler.toml`, then follow the
   [deployment procedure](#deploy-bruce), including review of every pending migration.
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

To switch subscription sales off again, set `PAYMENTS_ENABLED = "0"` through the
[deployment procedure](#deploy-bruce). Existing subscribers keep their plan row but stop being
charged only once you cancel their subscriptions in Stripe, so cancel there too.

## One-time top-up activation (owner qualification required)

Sales remain off until the exact release and private provider configuration are qualified. The
existing configuration hint is not proof of a usable offer or successful payment. The native
[sales-flow rehearsal](../notes/product/P-2.2be-sales-flow.md) uses synthetic responses through the
actual routes. It cannot establish the production account, key permissions, webhook delivery or
Managed Payments eligibility.

Before enabling sales, verify these separately without printing secrets or private provider objects:

- Confirm the intended Stripe account and mode with authorized provider access. Verify the exact
  configured `STRIPE_PRICE_TOPUP` using the pinned API version in `src/billing.js`. Its active
  one-time Price and Product, currency, amount, tax behavior and mode must satisfy
  `prepareTopupStripe` in `src/topup-stripe.js` and the approved public terms. Confirm the account
  and product support the existing `STRIPE_MANAGED_PAYMENTS` setting. A successful metadata read
  does not prove Checkout creation is permitted.
- Confirm the enabled endpoint is the intended Worker's `/billing/webhook`, in the intended mode
  and with the qualified event schema. Verify the deployed `STRIPE_WEBHOOK_SECRET` corresponds to
  that endpoint. Endpoint metadata alone does not prove secret equality or signed delivery. The
  top-up Checkout families are `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed` and `checkout.session.expired`. Also include the supported
  reversal families in `src/topup-reversal-types.js`: `refund.created`, `refund.updated`,
  `refund.failed`, `charge.refund.updated`, `charge.refunded`, and `charge.dispute.created`,
  `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn` and
  `charge.dispute.funds_reinstated`. Keep existing subscription and employer events.
- Confirm funded creation is ready with `FUNDED_RUNS_MODE=create`, `FUNDED_PURCHASES=1`, and explicit
  `FUNDED_RESPONSE_MAX_BYTES`, `FUNDED_RESPONSE_EVENT_BYTES` and `FUNDED_RESPONSE_DEADLINE_MS`.
  Qualify those bounds with the actual supported client. The event bound cannot exceed the body
  bound. Existing allowance, pause, rate and spending limits still apply.
- [Sales-provider correction #602](https://github.com/bpmcginley/InternshipFinder/pull/602) merged as
  `0deb1ea1`. It requires `STRIPE_TOPUP_MODE` set to `test` or `live`, with no default, and a signing-key
  presence gate for new sales. Before activation, verify the exact deployed Worker version includes
  that correction. A repository merge alone does not establish enforcement in production. These
  checks do not verify the real account or delivery by themselves.

Use a separate Worker, D1 database and signed webhook endpoint for provider test mode. Purchased
balances aggregate by user, so test and live purchases must not share the production database.
Keep test credentials and events confined to that isolated environment.

Read-only account, Price and endpoint checks can avoid creating a payment. Use the authorized
provider interface and keep full responses private. Record only the expected checks and pass/fail
results. Do not treat event resends, recovery POSTs or Checkout creation as read-only verification.
A return URL or open Checkout does not confirm payment. Use the authenticated fresh balance and
existing attached-checkout recovery behavior after verified settlement.

To stop new top-up sales, set `TOPUPS_ENABLED=0` through the approved deployment procedure. Keep the
historical Stripe key, Price and signing configuration so settlement, refunds, disputes and attached
recovery continue. Do not disable all subscription payments just to stop top-up sales.

To stop new funded AI generations, use `FUNDED_RUNS_MODE=drain` and retain valid response limits.
Existing funded generations may continue under their original charge. This affects new AI runs
beyond purchased runs. Do not revert to the legacy writer while funded generations can exist.
The qualified create/drain and old-run continuation fixtures are in
`test-support/ai-lifecycle.js`. No automatic down-migration or blanket legacy rollback is provided.

Historical coverage and automatic erasure have a separate
[approved proof requirement](../notes/product/P-2.2am-topup-history-design.md). An observed event
inventory or successful sales rehearsal does not establish continuous coverage or authorize erasure.

## Paid listings ("placements"; off until you set ADMIN_TOKEN)

Added 2026-10-14 (`src/placements.js`, API.md "Placements"). The tables `placements` and
`placement_log` record which listing an employer paid to show in a separate, labelled box, on which
days, and every change to that record. Payment never changes any score, order, filter, count or
Auto-Apply behaviour: a placement only points at a listing the normal pipeline already produced. No
payment code: you invoice from your own Stripe dashboard and record `pilot` or the invoice number when
you switch a placement on. No student data is in either table, and no recruiter name or email.

**Turn it on (once, on your own machine; Claude does neither step):**

1. `npx wrangler secret put ADMIN_TOKEN` (any long random string; it prompts for the value)
2. Follow the [deployment procedure](#deploy-bruce) with the approved migration set and backfills.

After the approved database steps, verify the placement schema objects:

```
npx wrangler d1 execute internscout --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'placement%'"
```

It should list `placements`, `placements_live`, `placement_log` and `placement_log_placement`. If not,
stop and reconcile the binding, migration ledger and expected schema through the coordinated release
procedure. Do not rerun deployment to repair unexplained schema drift.

**Day to day:** `scripts/placement.mjs` (no install). Put the same token in your shell's environment as
`INTERNSCOUT_ADMIN_TOKEN` (for example in PowerShell, `$env:INTERNSCOUT_ADMIN_TOKEN = Read-Host`, then
paste). The script never prints it and never takes it as an argument. What it prints leaves out
`paid_ref`.

```
node scripts/placement.mjs leads                      # recent leads: id, company, what they asked about
node scripts/placement.mjs create --lead 12 --listing 3f9c0a1b2c3d4e5f --url https://... --start 2026-11-01 --end 2026-12-01 --by bruce
node scripts/placement.mjs check p-2026-11-acme-1 --checks role_on_employer_site,email_domain,... --by bruce
node scripts/placement.mjs on p-2026-11-acme-1 --ref pilot --by bruce
node scripts/placement.mjs end p-2026-11-acme-1 --reason removed --by bruce
node scripts/placement.mjs list
```

`node scripts/placement.mjs help` lists every command and the eight sponsor checks. The admin routes
refuse any request from a browser, so they work only from a terminal. The daily cron ends a placement
on its end day. Read the tables directly with
`npx wrangler d1 execute internscout --remote --command "SELECT * FROM placements ORDER BY start_day DESC"`.

## Paid listings bought on the site (off until `EMPLOYER_CHECKOUT = "1"`)

Added 2026-10-19 (`src/orders/`, API.md "Paid listing orders"). Employers buy a listing on
internscout.org/employers/buy/ and you make one Approve or Refuse click per order from the review email.
The design, the rules and the steps to turn it on (Email Sending onboarding, the `[[send_email]]`
binding, the `REVIEW_TO` secret, the Stripe webhook events) are in [ORDERS.md](ORDERS.md).
`node scripts/placement.mjs orders` lists recent orders (no names or emails) and
`node scripts/placement.mjs pilot-code --note "first pilot"` makes one of the five pilot codes.

## Changing limits

- Allowances, models, prices and rate limits: `src/config.js`, then follow [Deploy](#deploy-bruce).
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
- Employer interest from the form on /employers/ (`src/leads.js`, added 2026-10-13), newest first:
  `npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"`.
  How many came in per day: `SELECT day, n FROM event_counts WHERE event = 'employer_interest'`.
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
