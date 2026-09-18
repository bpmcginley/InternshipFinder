# InternScout Worker

The product's only server: a Cloudflare Worker with a D1 database. It checks Google or Microsoft
sign-in, calls Gemini with the project's key, enforces monthly caps and the global budget, and counts
the states students pick. The request/response contract is in [API.md](API.md).

It stores only hashed IDs, usage counters, chosen states and monthly spend (`schema.sql`). Never
prompts, replies, emails or tokens. Workers Logs stay off for the same reason.

## Files

| File | What it does |
|---|---|
| `src/index.js` | Routes, CORS, daily cleanup cron |
| `src/auth.js` | ID token checks (JWKS, `iss`, `aud`, `exp`), `edu`/`general` tier, user hash |
| `src/limits.js` | Monthly allowance, per-minute/day rate limits, budget |
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

## Paid plans (Bruce, only when AI spend needs covering)

Two tiers, both optional, both dormant until you turn them on: `PAYMENTS_ENABLED = "0"` in
`wrangler.toml`, so `/config` says `payments: { enabled: false }`, the dashboard shows no upgrade
button and all three `/billing/*` routes return 404. Claude does none of these steps — keys stay
with you.

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
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
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
