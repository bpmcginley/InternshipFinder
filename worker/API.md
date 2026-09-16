# InternScout Worker API (v1)

The contract between the Cloudflare Worker (`worker/`), the extension (`extension/`) and the
dashboard (`docs/index.html`). Change it here first, then in all three.

## Base and CORS
- Base URL: `CONFIG.workerUrl` in the dashboard, `WORKER_URL` in `extension/lib/config.js`.
  Live: `https://internscout-api.bpmcginley.workers.dev`.
- CORS: origins from the `ALLOWED_ORIGINS` var (comma list; default
  `https://bpmcginley.github.io,http://localhost:8000,chrome-extension://jmjjgnckddhjbohfpbekodkpbpbmfjag`).
  Only InternScout's own extension ID, which the manifest `"key"` fixes for store and unpacked installs.
  Methods `GET, POST, DELETE, OPTIONS`; headers `Authorization, Content-Type`.

## Sign-in
- Anyone with a Google or Microsoft account can sign in (personal, school or work). Search never needs sign-in.
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
  - Dashboard: `https://bpmcginley.github.io/InternshipFinder/`
  - Extension: `https://jmjjgnckddhjbohfpbekodkpbpbmfjag.chromiumapp.org/`
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
    "edu":     { "resume_tailor": 8, "autofill": 15, "deep_dive": 2, "field_match": 200, "short_answer": 60 },
    "general": { "resume_tailor": 4, "autofill": 7,  "deep_dive": 1, "field_match": 100, "short_answer": 30 } },
  "paused": false }
```
The `general` allowance is `floor(edu × GENERAL_ALLOWANCE_PCT / 100)`, with a minimum of 1 per task. Only providers
with a client ID set are listed.

### `GET /me` (auth)
```json
{ "month": "2026-09", "plan": "free", "tier": "edu", "paused": false,
  "allowance": { "resume_tailor": { "used": 1, "limit": 8 }, "autofill": { "used": 0, "limit": 15 } } }
```

### `DELETE /me` (auth)
Deletes every usage and demand row for this user. Returns `{ "ok": true }`.

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
- **Rate limits:** 10 calls/min and 300 calls/day per user, counted over all tasks. On top of that,
  `GLOBAL_RPM` calls/min across every user together; over that the Worker returns `503 busy` without
  spending the caller's rate bucket or allowance.
- **Response:** without `?stream=1`, the Worker returns the Gemini `generateContent` JSON response unchanged. With `?stream=1`, it passes through Gemini's `streamGenerateContent?alt=sse` as `text/event-stream`.
- **Success headers:**
  - `X-InternScout-Model`
  - `X-InternScout-Remaining`: units left for this task this month
- **Cost tracking:** each call's `usageMetadata` tokens are priced from the config table and added to the month's budget. Prompts and replies are never stored or logged.

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

## Worker secrets and vars
- **Secrets** (Bruce sets them with `wrangler secret put`):
  - `GEMINI_API_KEY`
  - `HASH_SALT`
  - `DEMAND_TOKEN`
- **Vars:**
  - `GOOGLE_CLIENT_ID`, `MS_CLIENT_ID` (a provider is off while its ID is empty)
  - `EDU_EXTRA_DOMAINS` (comma list of non-`.edu` school domains, default empty), `GENERAL_ALLOWANCE_PCT` (default 50)
  - `ALLOWED_ORIGINS`
  - `MONTHLY_BUDGET_CENTS` (default 2500)
  - `GLOBAL_RPM` (AI calls per minute across everyone, default 120; `"0"` turns AI off)
- **D1 binding:** `DB`, with tables `usage`, `runs`, `rate`, `demand`, `budget`. The schema is in `worker/schema.sql`.

## Dashboard ↔ extension bridge
- The existing bridge (`extension/bridge/bridge.js`) relays `{__internscout:"req", id, msg}`. The background worker handles it by `msg.type`.
- **New message types:**
  - `{type:"profile:set", profile:{majors, minors, class_year, grad_term, stages, terms, states, work_auth}}` returns `{ok:true}`. The extension stores `majors`, `class_year` and `grad_term` in `profile.facts`.
  - `{type:"profile:get"}` returns `{profile}`.
  - `{type:"auth:token"}` returns `{token}` or `{token:null}`. The dashboard can reuse the extension's sign-in.
