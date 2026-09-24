# InternScout Worker API (v1)

The contract between the Cloudflare Worker (`worker/`), the extension (`extension/`) and the
dashboard (`docs/index.html`). Change it here first, then in all three.

## Base and CORS
- Base URL: `CONFIG.workerUrl` in the dashboard, `WORKER_URL` in `extension/lib/config.js`.
  Live: `https://internscout-api.bpmcginley.workers.dev`.
- CORS: origins from the `ALLOWED_ORIGINS` var (comma list; default
  `https://internscout.org,https://bpmcginley.github.io,http://localhost:8000,chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag,chrome-extension://hpnbbpmalfjijnmpoihhjgjolhabjpgi`).
  Only InternScout's own two extension IDs: `jmjj…` is Load unpacked (fixed by the manifest `"key"`), and
  `hpnbb…` is the Chrome Web Store copy, whose ID the store assigned.
  Methods `GET, POST, DELETE, OPTIONS`; headers `Authorization, Content-Type`.

## Sign-in
- Anyone with a Google or Microsoft account can sign in (personal, school or work). Search never needs sign-in.
  Until the Entra app has publisher verification, most school/work Microsoft tenants (UMass included) ask
  for admin approval, so in practice Microsoft sign-in is for personal accounts.
- Request header: `Authorization: Bearer <OIDC ID token>`. The Worker picks the provider from the token's `iss`:
  - **Google:** `iss` is `https://accounts.google.com` (or `accounts.google.com`), `aud == GOOGLE_CLIENT_ID`.
  - **Microsoft:** the app is multi-tenant (`common` authority). `iss` must equal
    `https://login.microsoftonline.com/{tid}/v2.0` using the token's own `tid`, and `aud == MS_CLIENT_ID`.
- The Worker checks, in this order:
  1. Signature, using the provider's JWKS (cached 1 h).
  2. `iss`, `aud` and `exp` (60 s leeway).
  3. Tier (see below). A token that passes 1–2 always gets at least the `general` tier.
- **Tier:** set on each request and never stored.
  - **`edu`:** the email is verified and its domain ends in `.edu`, or is listed in `EDU_EXTRA_DOMAINS`.
    - Google: `email_verified == true` and the `email` domain qualifies.
    - Microsoft: only work/school accounts (`tid` is not the consumer tenant
      `9188040d-6c67-4c5b-b112-36a304b66dad`) with `xms_edov == true` and a qualifying `email` domain.
      Bruce adds the optional claims `email` and `xms_edov` to the app registration.
  - **`general`:** everyone else.
- Identity: `user_hash = hex(sha256(iss_provider + "|" + sub + "|" + HASH_SALT))`, where `iss_provider` is `google` or
  `microsoft`, so a Microsoft user keeps one hash across tenants. No email, name or token is stored.
- Redirect URIs Bruce registers with the provider:
  - Dashboard: `https://internscout.org/` (and the old `https://bpmcginley.github.io/InternshipFinder/`,
    which GitHub Pages now redirects to it)
  - Extension, Load unpacked: `https://jmjjgnckddhjbohfpbekodkpbpbmfjag.chromiumapp.org/`
  - Extension, Chrome Web Store: `https://hpnbbpmalfjijnmpoihhjgjolhabjpgi.chromiumapp.org/`
- Clients use the implicit flow (`response_type=id_token`, a random `nonce`, `scope=openid email profile`).
  - Dashboard: keeps the token in `sessionStorage["internscout.idtoken"]`.
  - Extension: uses `chrome.identity.launchWebAuthFlow` and keeps the token in `chrome.storage.session`.
  - Both check `exp` and sign in again when it's expired.

## Errors
Every error is JSON `{ "error": code, "message": text }`:

| Status | code | When |
|---|---|---|
| 400 | `bad_request` / `bad_task` | invalid body or unknown task |
| 401 | `auth` | missing, expired or invalid token |
| 429 | `cap` | monthly allowance for the task is used up; includes `task`, `resets` (ISO date) |
| 429 | `rate` | this caller's per-minute or per-day call limit; includes `retry_after` (s) |
| 503 | `busy` | everyone's calls together hit `GLOBAL_RPM` for this minute; nothing to do with this caller's own limits, so retry after `retry_after` (s) |
| 503 | `paused` | global monthly budget reached; search still works |
| 502 | `upstream` | Gemini failed |

## Endpoints

### `GET /config` (no auth)
```json
{ "providers": [
    { "id": "google", "client_id": "…", "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
      "scopes": ["openid", "email", "profile"] },
    { "id": "microsoft", "client_id": "…",
      "authorize_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "scopes": ["openid", "email", "profile"] } ],
  "allowance": {
    "edu":       { "resume_tailor": 10, "autofill": 20,  "deep_dive": null, "field_match": 260,  "short_answer": 80 },
    "general":   { "resume_tailor": 5,  "autofill": 10,  "deep_dive": null, "field_match": 130,  "short_answer": 40 },
    "supporter": { "resume_tailor": 25, "autofill": 50,  "deep_dive": null, "field_match": 650,  "short_answer": 200 },
    "pro":       { "resume_tailor": 60, "autofill": 120, "deep_dive": null, "field_match": 1560, "short_answer": 480 } },
  "payments": { "enabled": false, "plans": [] },
  "paused": false,
  "invite": { "bonus": { "autofill": 3 }, "max": 10 } }
```
`invite` is what an invite is worth (`REFERRAL` in config.js; see `GET /invite`). The dashboard shows
invite features only when it is present.

The `general` allowance is `floor(edu × GENERAL_ALLOWANCE_PCT / 100)`, with a minimum of 1 per task. Only providers
with a client ID set are listed.

There is one `allowance` block per paid tier as well, each the `edu` allowance times that tier's
multiplier (rounded), so the dashboard can say exactly what upgrading buys. A tier appears only while
its own Stripe price id is set. When paid plans are on, `payments` looks like

```json
{ "enabled": true, "plans": [
    { "plan": "supporter", "label": "Supporter", "price": "$5/month", "multiplier": 2.5 },
    { "plan": "pro",       "label": "Pro",       "price": "$12/month", "multiplier": 6 } ] }
```

and otherwise it is `{ "enabled": false, "plans": [] }`.

### `GET /me` (auth)
```json
{ "month": "2026-09", "plan": "free", "plan_renews": null, "tier": "edu", "paused": false,
  "can_upgrade": true, "can_manage": false,
  "allowance": { "resume_tailor": { "used": 1, "limit": 10 }, "autofill": { "used": 0, "limit": 20 } } }
```
- **`plan`** is `free` or the id of a paid tier (`supporter`, `pro`). `limit` already includes the
  plan multiplier, so the client never multiplies anything itself.
- **`plan_renews`** is the paid-through date (ISO) while subscribed, else `null`.
- **`can_upgrade`** is true when payments are on and a larger tier than the current one is offered, so
  it stays true for a Supporter while Pro exists and goes false on the top tier.
- **`can_manage`** is true when they have a Stripe customer, so the dashboard can show "Manage subscription".
- **Invite units** (see `GET /invite`) are already in `limit`: it is the month's allowance, or what was
  used if invite units took the student past it, plus the invite units left. So `limit - used` is always
  what they can still run, and an older client needs no change. A task with invite units left also
  carries `"bonus": 3`.

### `GET /invite` (auth)
The student's own invite link, made on first ask:
```json
{ "code": "k7m2qpxa", "link": "https://internscout.org/?ref=k7m2qpxa", "rewarded": 1, "max": 10,
  "bonus": { "autofill": 3 }, "left": { "autofill": 3 } }
```
`rewarded` is how many classmates have earned them credit (at most `max`); `left` is their unused
invite units. The code is random and says nothing about the student.

### `POST /invite/claim` (auth)
Body `{ "code": "k7m2qpxa" }`, sent by the dashboard once a student who arrived on `?ref=` signs in.
Returns `{ "ok": true, "bonus": { "autofill": 3 }, "inviter_rewarded": true }`: both accounts get
`REFERRAL.bonus` (config.js), the inviter only while under `REFERRAL.maxRewards`. Invite units never
expire and are spent only after the month's allowance for that task (`admit()` in limits.js), still
under the account's spend ceiling and both budget stops. Refusals: `400 bad_invite` / `404 bad_invite`
(not a code), `400 own_invite`, `403 edu_only` (the claimer isn't a school .edu account),
`409 not_new` (the account was first seen more than `REFERRAL.windowDays` ago), `409 already_claimed`
(one invite per account, ever).

### `DELETE /me` (auth)
Deletes this user's demand and plan rows, every usage, run and spend row from earlier months, and
their invite code, invite units and first-seen date. Their name comes off every invite record; their
own record of joining through an invite stays, without the inviter, so they can't claim a second one.
Returns `{ "ok": true }`.

This month's usage, run, spend and rate rows stay until the month ends: they are a hashed ID and
numbers, and deleting them on request would let an account at its cap reset it by deleting and
signing in again. A `forget` row marks the account, and the daily cron removes the rest once the
month is over.

While a subscription is active it returns `409 subscribed` instead: cancelling in Stripe has to come
first, so nothing keeps billing a card for an account that no longer exists here.

### `POST /ai` (auth)
Body:
```json
{ "task": "autofill", "run_id": "uuid-from-client",
  "request": { "contents": [], "systemInstruction": {}, "tools": [], "toolConfig": {}, "generationConfig": {} } }
```
- **`task`** is one of `resume_tailor`, `autofill`, `deep_dive`, `field_match` or `short_answer`.
- **`request`** is a Gemini `generateContent` body with no model field.
  - The Worker picks the model per task in `worker/src/config.js`.
  - It clamps `maxOutputTokens` and the thinking settings to that task's ceiling.
  - It drops any field not listed above.
- **Allowance units:**
  - One unit is one distinct `(task, run_id)` per month.
  - A multi-call Auto-Apply or Deep Dive run costs 1 unit.
  - Each run is capped at `MAX_CALLS_PER_RUN` calls (config; default 60). Past that, the Worker returns `429 cap`.
  - A missing `run_id` means every call is its own run.
- **Account ceiling:** each account may cost at most `USER_BUDGET_CENTS[plan]` a month over all tasks
  (config; free 300, supporter 450, pro 1100 cents; a `general` free account gets `GENERAL_ALLOWANCE_PCT`
  of the free row). Past it the Worker returns `429 cap` with `resets`. This is what bounds the
  uncapped Deep Dive; a student using the extension as built never reaches it.
- **Body size:** `TASKS[task].maxBodyBytes` (200 KB for `field_match` and `short_answer`, 1.5 MB for
  `resume_tailor` and `autofill`); only `deep_dive` may use the full `MAX_BODY_BYTES`. Over it: `400 bad_request`.
- **Parts:** a part may carry `text`, `inlineData`, `functionCall`, `functionResponse` (`response` only)
  and `thoughtSignature`. Anything else is dropped, `fileData` above all: a `fileUri` makes Gemini
  fetch a file by reference, so a tiny request could cost a million input tokens.
- **Rate limits:** 10 calls/min and 300 calls/day per user, counted over all tasks. On top of that,
  `GLOBAL_RPM` calls/min across every user together; over that the Worker returns `503 busy` without
  spending the caller's rate bucket or allowance.
- **Response:** without `?stream=1`, the Worker returns the Gemini `generateContent` JSON response unchanged. With `?stream=1`, it passes through Gemini's `streamGenerateContent?alt=sse` as `text/event-stream`.
- **Success headers:**
  - `X-InternScout-Model`
  - `X-InternScout-Remaining`: units left for this task this month
- **Cost tracking:** an estimate (body size plus a full-length reply) is charged to the month's budget and the
  account's `spend` row before Gemini is called, then corrected to the priced `usageMetadata` afterwards; a
  Gemini failure gives the unit and the estimate back. Every limit is one conditional write, so a parallel
  burst cannot pass a cap between a read and a write. Token totals per month (calls, prompt, cached, output)
  go in `tokens`; `cached / prompt` is the cache hit rate. Prompts and replies are never stored or logged.

### `POST /demand` (auth)
Body: `{ "states": ["MA", "NY", "REMOTE"] }`, using USPS codes plus `REMOTE` (max 60). Replaces the user's row. Returns `{ "ok": true }`.

### `GET /demand` (CI only)
Needs `Authorization: Bearer <DEMAND_TOKEN>` (a secret). Returns:
```json
{ "states": { "MA": 12, "NY": 5 }, "users": 17, "updated": "2026-09-14T00:00:00Z" }
```
Only users active in the last 90 days count. The ingest workflow reads this with the repo secrets
`INTERNSCOUT_DEMAND_URL` + `INTERNSCOUT_DEMAND_TOKEN` and passes the state codes to the backend as
`INTERNSCOUT_WANTED_STATES`.

## Paid plans (optional, off by default)

Every route below returns `404 not_found` unless `PAYMENTS_ENABLED` is `"1"` **and** `STRIPE_SECRET_KEY`
and at least one price id are set (the webhook also needs `STRIPE_WEBHOOK_SECRET`). Each tier is
offered separately: `STRIPE_PRICE_ID` turns on Supporter and `STRIPE_PRICE_ID_PRO` turns on Pro, so
launching with one tier and adding the other later needs no code change. Stripe holds the card,
name and email. The Worker stores only the hashed user id, the Stripe customer and subscription ids, a
status and the paid-through date.

### `POST /billing/checkout` (auth)
Body is optional: `{ "plan": "supporter" | "pro" }`, defaulting to the first offered tier. Returns
`{ "url": "https://checkout.stripe.com/…" }` for the student to open. The session carries
`client_reference_id = user_hash` only, so a payment can be matched back to an account without Stripe
learning who the student is. `400 bad_plan` for a tier that isn't offered, and `409 already` if they
already have any paid plan — switching tiers happens in the portal, where Stripe prorates it.

### `POST /billing/portal` (auth)
Returns `{ "url": … }` for Stripe's own billing portal (change card, cancel). `404` if there is no
Stripe customer for this user. We build no billing screens.

### `POST /billing/webhook` (Stripe only, no sign-in)
Needs a valid `Stripe-Signature` header; an unverified body never changes a plan. A signature more than
5 minutes old is refused, and a repeated event id returns `{ "ok": true, "repeat": true }` without
applying twice. A signature header may carry several `v1=` values (Stripe sends one per live secret
while a secret is being rolled); any one that matches is enough. Handled types:
`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
`charge.refunded` (only a full refund) and `charge.dispute.created`, which both cancel the
subscription and put the student back on free. Anything else is ignored.

The tier comes from the subscription's price id rather than its metadata, because a student who
switches tier inside Stripe's portal keeps the metadata the original checkout wrote. Metadata is only
the fallback when no price matches a known tier.

In the Stripe dashboard the endpoint URL is `<worker-url>/billing/webhook`.

## Worker secrets and vars
- **Secrets** (Bruce sets them with `wrangler secret put`):
  - `GEMINI_API_KEY`
  - `HASH_SALT`
  - `DEMAND_TOKEN`
  - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (Supporter), `STRIPE_PRICE_ID_PRO` (Pro),
    `STRIPE_WEBHOOK_SECRET` — only for the paid plans
- **Vars:**
  - `GOOGLE_CLIENT_ID`, `MS_CLIENT_ID` (a provider is off while its ID is empty)
  - `EDU_EXTRA_DOMAINS` (comma list of non-`.edu` school domains, default empty), `GENERAL_ALLOWANCE_PCT` (default 50)
  - `ALLOWED_ORIGINS`
  - `MONTHLY_BUDGET_CENTS` (default 7500)
  - `GLOBAL_RPM` (AI calls per minute across everyone, default 120; `"0"` turns AI off)
  - `PAYMENTS_ENABLED` (`"0"` by default), `SUPPORTER_PRICE_TEXT` and `PRO_PRICE_TEXT` (display only),
    `SITE_URL` (where Stripe returns to)
- **D1 binding:** `DB`, with tables `usage`, `runs`, `rate`, `demand`, `budget`, `plans`, `stripe_events`.
  The schema is in `worker/schema.sql`.

## Dashboard ↔ extension bridge
- The existing bridge (`extension/bridge/bridge.js`) relays `{__internscout:"req", id, msg}`. The background worker handles it by `msg.type`.
- **New message types:**
  - `{type:"profile:set", profile:{majors, minors, class_year, grad_term, stages, terms, states, work_auth}}` returns `{ok:true}`. The extension stores `majors`, `class_year` and `grad_term` in `profile.facts`.
  - `{type:"profile:get"}` returns `{profile}`.
  - `{type:"auth:token"}` returns `{token}` or `{token:null}`. The dashboard can reuse the extension's sign-in.
