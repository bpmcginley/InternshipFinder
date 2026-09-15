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
5. `npm run deploy`. Note the `*.workers.dev` URL it prints.
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
- `https://<extension-id>.chromiumapp.org/`, for each extension ID in use. The unpacked ID depends on
  the load folder, and the Chrome Web Store ID is different, so add that one after the first upload.

## Changing limits

- Allowances, models, prices and rate limits: `src/config.js`, then deploy.
- Global monthly budget: `MONTHLY_BUDGET_CENTS` in `wrangler.toml`. Keep the Google Cloud budget
  alert ($25) in step with it.
- Share of the allowance for non-.edu accounts: `GENERAL_ALLOWANCE_PCT`.
- Extra school domains that don't end in `.edu`: `EDU_EXTRA_DOMAINS`.
- New allowed site origin (for example a custom domain): add it to `ALLOWED_ORIGINS`, and to both
  sign-in providers' redirect URIs.
