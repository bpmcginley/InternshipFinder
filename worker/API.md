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
  <!-- was: Methods `GET, POST, DELETE, OPTIONS`; headers `Authorization, Content-Type`. -->
  Methods `GET, POST, PUT, DELETE, OPTIONS` (`PUT` is for `PUT /profile`); headers `Authorization, Content-Type`.
  A preflight (`OPTIONS`, any path) answers 204 with these headers for an allowed origin.

## Public brand videos

`GET` or `HEAD /social-video/YYYY-MM-DD-field.mp4` serves a generated brand Reel from the fixed
`bpmcginley/InternshipFinder` repository's `social-cards` branch as `video/mp4`. No sign-in, database,
visitor counting, or new storage is involved. Only dated lowercase field filenames are accepted;
queries, nested paths and upstream redirects are refused. Files must have a declared positive size
at most 16 MiB; GET streams enforce that size. Single byte ranges are supported and return 206 when
the upstream honors them. HEAD fetches only metadata. Success is cached for an hour; failures are
not cached. Unknown files return 404, invalid ranges 416, unsupported methods 405, and unavailable
or unsupported upstream media 502. Incoming credentials/cookies are never forwarded. This route
exists for Meta's public `video_url` fetch, not for arbitrary user uploads or a general proxy.

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
  <!-- was:
  - Dashboard: keeps the token in `sessionStorage["internscout.idtoken"]`.
  - Extension: uses `chrome.identity.launchWebAuthFlow` and keeps the token in `chrome.storage.session`.
  - Both check `exp` and sign in again when it's expired. -->
  - Then both trade the ID token for a session (`POST /session`, below) and keep the session record:
    the dashboard in `localStorage["internscout.session"]`, the extension (which gets the ID token from
    `chrome.identity.launchWebAuthFlow`) in `chrome.storage.local["internscout.session"]`. The student
    stays signed in on that device until they sign out or leave it unused for a year.
  - A Worker without `/session` (404, a network error or a 5xx) falls back to the old way: the raw ID
    token (dashboard `sessionStorage["internscout.idtoken"]`, extension `chrome.storage.session`),
    checked against `exp` and signed in again when it's expired.

## Sessions ("stay signed in")
- A session token is opaque: `"iss_" + base64url(32 random bytes)` (no padding, 47 characters). Every
  authenticated route accepts it as `Authorization: Bearer iss_…` in place of an ID token; ID tokens keep
  working exactly as above.
- A session gives the same `{ user, tier }` as the ID token it was made from. The tier is fixed when the
  session is made (signing in again makes a new one with the current tier).
- The Worker stores only `sha256(token)` (hex) with the `user_hash`, tier, provider and three dates
  (`sessions` in `schema.sql`). Never the token, never the email.
- Sliding expiry: a year (365 days) from the last use. A use moves `last_used` and `expires` forward at
  most once per UTC day, after the response (`ctx.waitUntil`). The daily cron deletes expired rows.
- At most 20 sessions per account: making the 21st deletes the least recently used.
- An unknown, deleted or expired session answers `401 auth` with the message
  `Sign-in expired; sign in again`. The extension then drops its session so the UI shows "Sign in".

## Errors
Every error is JSON `{ "error": code, "message": text }`:

| Status | code | When |
|---|---|---|
| 400 | `bad_request` / `bad_task` | invalid body or unknown task |
| 401 | `auth` | missing, expired or invalid token, or an unknown or expired session |
| 409 | `stale` | `PUT /profile` older than the saved copy; includes `profile` and `updated` (the saved copy) |
| 409 | `subscribed` | `DELETE /me` while a paid plan is live |
| 429 | `cap` | monthly allowance for the task is used up; includes `task`, `resets` (ISO date), `tier`, `upgrade` (a bigger plan is on offer) and `offer` (that plan, as `upgrade_offer` in `GET /me`, or `null`) |
| 429 | `rate` | this caller's per-minute or per-day call limit; includes `retry_after` (s) |
| 503 | `busy` | everyone's calls together hit `GLOBAL_RPM` for this minute; nothing to do with this caller's own limits, so retry after `retry_after` (s) |
| 503 | `paused` | global monthly budget reached; search still works |
| 503 | `sync_off` | `/profile` while the `PROFILE_KEY` secret is unset |
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
  "invite": { "bonus": { "autofill": 3 }, "max": 10 },
  "sessions": true,
  "sync": true }
```
`sessions: true` says this Worker has `POST /session` (an older one lacks both flags). `sync` is whether
saving the Deep Dive to the account is on, which is whether the `PROFILE_KEY` secret is set.

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
  "upgrade_offer": { "plan": "supporter", "label": "Supporter", "price": "$4/month", "allowance": { "resume_tailor": 20, "autofill": 50 } },
  "allowance": { "resume_tailor": { "used": 1, "limit": 15 }, "autofill": { "used": 0, "limit": 40 } } }
```
- **`plan`** is `free` or the id of a paid tier (`supporter`, `pro`). `limit` already includes the
  plan multiplier, so the client never multiplies anything itself.
- **`plan_renews`** is the paid-through date (ISO) while subscribed, else `null`.
- **`can_upgrade`** is true when payments are on and a larger tier than the current one is offered, so
  it stays true for a Supporter while Pro exists and goes false on the top tier.
- **`upgrade_offer`** is the smallest plan above the current one and the monthly allowance it would give
  this student (at their own tier, so a non-.edu account sees its share), or `null` when there is none.
  The dashboard and the extension's Upgrade button quote it.
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
<!-- was: `rewarded` is how many classmates have earned them credit (at most `max`); `left` is their unused
invite units. The code is random and says nothing about the student. -->
`rewarded` is how many classmates have earned them credit, ever (at most `max`; the `inviters` count,
which `DELETE /me` keeps, so deleting and signing in again shows the same number and a new code);
`left` is their unused invite units. The code is random and says nothing about the student.

### `POST /invite/claim` (auth)
Body `{ "code": "k7m2qpxa" }`, sent by the dashboard once a student who arrived on `?ref=` signs in.
Returns `{ "ok": true, "bonus": { "autofill": 3 }, "inviter_rewarded": true }`: both accounts get
`REFERRAL.bonus` (config.js), the inviter only while under `REFERRAL.maxRewards`. Invite units never
expire and are spent only after the month's allowance for that task (`admit()` in limits.js), still
under the account's spend ceiling and both budget stops. Refusals: `400 bad_invite` / `404 bad_invite`
(not a code), `400 own_invite`, `403 edu_only` (the claimer isn't a school .edu account),
`409 not_new` (the account was first seen more than `REFERRAL.windowDays` ago), `409 already_claimed`
(one invite per account, ever).
<!-- Added 2026-09-25: the claim and the grants used to be two separate writes. -->
The claim and both grants are one D1 batch (one transaction), so a failure part-way leaves nothing
recorded and the claim can simply be sent again. An account that existed before invites did (2026-09-24)
is dated by `schema.sql`'s backfill from its earliest usage month, states or plan, so it is not `new`.

### `POST /session` (ID token only)
`Authorization: Bearer <provider ID token>`. A session token here is `401 auth`: only a fresh sign-in
with Google or Microsoft can start a session. Returns
```json
{ "session": "iss_…", "account": "3f2a9c0d1e5b7a64", "email": "student@umass.edu",
  "provider": "google", "tier": "edu", "expires": "2027-09-26T14:03:11.000Z" }
```
- **`account`** is the first 16 hex characters of the `user_hash`: a stable, non-identifying id for the
  client (it stands in for the token's `sub`, e.g. in dedupe keys).
- **`email`** is the token's `email` claim (for a Microsoft token without one, `preferred_username`), for
  the client to show "Signed in as …". It is echoed, not stored.
- **`expires`** is a year from now; it slides forward with use (see "Sessions").

An invalid ID token is `401 auth`, as on every route.

### `DELETE /session`
`Authorization: Bearer iss_…` deletes that session (signs that device out). Always `200 { "ok": true }`:
an ID token, an unknown or already deleted session, or no header at all is already signed out.

### `GET /session` (session token only)
`Authorization: Bearer iss_…`. Says whose a live session is, for a client that was handed a session
token rather than making it (the extension checks the sign-in the dashboard offers it, 2026-10-14):
```json
{ "account": "3f2a9c0d1e5b7a64", "provider": "google", "tier": "edu", "expires": "2027-09-26T14:03:11.000Z" }
```
The same fields as `POST /session` without `session` and `email` (the email is never stored). Counts as
a use of the session (the sliding year). An ID token, an unknown, expired or deleted session, or no token
is `401 auth`.

### `POST /session/copy` (session token only)
`Authorization: Bearer iss_…`. A new, separate session for the same account, tier and provider, so a
client handed a session (the extension taking the dashboard's sign-in, 2026-10-14) gets its own and the
two sign out separately. Same reply as `POST /session` without `email`:
```json
{ "session": "iss_…", "account": "3f2a9c0d1e5b7a64", "provider": "google", "tier": "edu", "expires": "2027-09-26T14:03:11.000Z" }
```
A session can be copied once, and a copy can't be copied (`session_copies` in `schema.sql` keeps both
sessions' sha256 ids and the `user_hash`), so a stolen session token can make one more at most. A second
copy is `409 copied`; an ID token, an unknown, expired or deleted session, or no token is `401 auth`.
The new session counts toward the 20 per account. Delete my data removes the copy records; the daily
cron removes one once neither of its sessions is left.

### `GET /profile` (auth)
The Deep Dive saved to the account: `{ "profile": { … } | null, "updated": "<ISO>" | null }`.
`null`s mean nothing is saved.

### `PUT /profile` (auth)
Body `{ "profile": { … }, "updated": "<ISO>" }`, at most 256 KB (`400 bad_request` over it, or when
`profile` isn't an object or `updated` isn't a date). `updated` is the client's time for its latest
edit; it is stored as `toISOString()`, and a time later than the Worker's own clock is stored as the
Worker's time (a device whose clock runs fast would otherwise make every other device's save stale). The
reply's `updated` is the time actually stored; clients keep that one.
- The client sends only the synced subset (see the extension's `lib/sync.js`): never files, saved
  logins, API keys, or the six demographic answers. The Worker deletes those six keys
  (`gender, race, hispanic, veteran, disability, lgbtq`) from `profile.facts` again before storing.
- If the saved copy's `updated` is later than the body's: `409 { "error": "stale", "message": …,
  "profile": <saved>, "updated": "<saved ISO>" }`, and nothing is written; the client merges the saved
  copy in. An equal time overwrites (a retried save succeeds). The write is conditional on the same
  rule, so two devices saving at once can't leave the older copy on top.
- Otherwise `200 { "ok": true, "updated": "<ISO stored>" }`.
- **Encrypted at rest:** AES-GCM-256 with a fresh 12-byte IV per write; the row holds
  `base64(iv || ciphertext)` and the plaintext size. The key is HKDF-SHA256 with ikm = the
  base64-decoded `PROFILE_KEY` secret (32 bytes), salt `"internscout-profile-v1"`, info = the
  `user_hash`, so every account has its own key. A row that no longer decrypts (the secret was
  replaced) reads as nothing saved, and the next `PUT` replaces it whatever its time.

### `DELETE /profile` (auth)
Deletes the saved copy (the student unticked "Save my Deep Dive to my account"). `200 { "ok": true }`,
also when there was none.

All three `/profile` routes answer `503 { "error": "sync_off", "message": "Saving profiles isn't turned on yet." }`
while `PROFILE_KEY` is unset (`GET /config` then says `"sync": false`), before looking at the sign-in.

### `DELETE /me` (auth)
<!-- was: Deletes this user's demand and plan rows, every usage, run and spend row from earlier months, and
their invite code, invite units and first-seen date. Their name comes off every invite record; their
own record of joining through an invite stays, without the inviter, so they can't claim a second one.
Returns `{ "ok": true }`. -->
Deletes this user's demand and plan rows, every usage, run and spend row from earlier months, and
their invite code and invite units. Their name comes off every invite record. Three invite rows stay,
each a hashed ID with a date or a number, because each is what stops deleting and signing in again
from resetting a rule: their own record of joining through an invite (without the inviter), so they
can't claim a second one; their first-seen date (`accounts`), so an old account can't claim as new;
and their lifetime count of rewarded invites (`inviters`), so an inviter at `max` can't earn 10 more.
The saved Deep Dive (`profiles`) and **every** session of the account (`sessions`) go too, in the same
batch, so the account is signed out on every device. Returns `{ "ok": true }`.

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

### `POST /hit` (site only, no auth)
One page load on internscout.org, sent by `docs/js/count.js` with `sendBeacon` as `text/plain`:
`{ "p": "/internships/ohio/", "r": "www.google.com", "u": "digest", "m": "email", "c": "weekly-2026w44", "t": "search-card" }` (path, referring
host, utm_source, utm_medium, utm_campaign and utm_content; all optional). Answers `204` and adds one to `visit_counts` for the UTC
day, the page kind (`dashboard`, `landing`, `install`, `legal`, `digest`, `employers`, `other`) and the source (`direct`,
`search`, `social`, `email`, `extension`, `print` (a flyer's QR code), `other`, or `internal` for a load from another page of the
site, which counts as a view but not a visit). Nothing about the visitor is stored.
A `social` load also adds one to `visit_channels` for the day and the site (added 2026-10-05):
`youtube`, `tiktok`, `x`, `facebook`, `reddit`, `instagram`, `bluesky`, `mastodon`, `linkedin`,
`threads` or `discord`, from `u` (utm_source; `fb`, `ig`, `bsky` and `twitter` are spelled out) or else
from the family of `r` (`youtu.be`, `l.facebook.com`, `t.co` and the like). `source` stays `social`,
so the dashboard's and `growth/metrics.py`'s sums are unchanged; the weekly scorecard reads
`SELECT channel, SUM(visits) FROM visit_channels WHERE day >= date('now','-6 day') GROUP BY channel`.
A printed flyer's QR code (added 2026-10-06) carries `utm_source=flyer-<spot>&utm_medium=print`: its
`source` is `print` and its channel is the tag itself (`flyer-library`), one per posting location. Tags
must match `flyer` or `flyer-[a-z0-9]{1,16}`, and a day takes at most 40 distinct flyer channels, so a
hand-typed URL cannot add rows without limit.
With `"e"` it is a step instead of a page load: `{ "e": "signin", "p": "/" }` adds one to
`event_counts` for the day, the step and the page kind. Steps: `install_click`, `signin_start`,
`signin`, `profile`, `autoapply`, `checkout`, `invite_open` (a signed-in student opened their invite
link panel, from the one-time nudge after a first Auto-Apply or profile or from the Account menu; added
2026-10-02), `posting_click` (a click through to a posting: `a.go` on a landing page, `a.open-link` on
the dashboard; added 2026-10-04), `apply_offer_shown` and `apply_offer_click` (the "Add to Chrome" bar
`docs/js/offer.js` shows after a posting Auto-Apply fills is opened, and its store link pressed; added
2026-10-13), `review_click`, and `digest_signup` (a form submission, **not a confirmed subscriber**).
Since 2026-10-15 the finite `digest_<step>_<placement>` names also count weekly email invitations:
`step` is `view`, `click` or `submit`; `placement` is `footer`, `results_inline`, `digest_page`,
`landing`, `contextual` or `nav`. A view means at least 25% of the marked invitation intersected the
viewport; unsupported browsers do not estimate views. Each event counts at most once per page load.
These remain anonymous daily totals; no email, field selection or subscriber status is stored.
`digest_signup` remains the legacy total across forms and must not be added to the placement
submission totals (that would double-count). No `digest_confirmed` event is accepted. See
[`growth/SIGNUP_MEASUREMENT.md`](../growth/SIGNUP_MEASUREMENT.md) for the separate aggregate
confirmed-subscriber check. Any other name is ignored. The Worker adds its own steps to the same
table (`src/visits.js` `SERVER_EVENTS`, added 2026-10-04), which `/hit` never accepts: `new_account`
(an account seen for the first time; page `extension` or `dashboard` by `Origin`), `ext_signin`
(`POST /session` from the extension), `first_autofill` (an account's first answered Auto-Apply run of
the month), `cap_hit` (a run refused at the monthly allowance; page is the task), `paid` (a live-mode
`checkout.session.completed` that left a plan active, once per Stripe event id; page is the plan) and
`employer_interest` (`POST /employer-interest` stored a lead; page `employers`; added 2026-10-13).
A load arriving from Google or Microsoft sign-in or from Stripe counts as `internal` (the same visit going on).
`403` unless `Origin` is the live site. Script-running crawlers (by user agent), more than 30 hits a
minute from one address (counted in memory only), and anything past 50,000 views in a day are
answered `204` but not counted. The Worker's own steps are not under that daily cap (2026-10-04), so a
flood of forged browser steps cannot stop a real sign-in or sale from being counted.
Since 2026-10-27, `install_click`, `digest_signup` and `employer_order_submit` also add an anonymous
row to `event_attribution` when a source, channel, campaign or content tag is available. The page
keeps the five bounded tags only in the current tab's session storage so a later InternScout page can
attribute its intent event; closing the tab clears them. Campaign and content must be lowercase
letters, digits, `_` or `-`, at most 48 characters. A day accepts at most 200 distinct attribution
rows. These are intent events, not Chrome-confirmed installs, Buttondown-confirmed subscribers or
Stripe-confirmed employer payments. The provider totals remain the truth for those outcomes. See
[`growth/ATTRIBUTION.md`](../growth/ATTRIBUTION.md) for safe queries and interpretation.
With `"s"` it is a paid listing's box (added 2026-10-14, S9; `docs/js/count.js`): `{ "s": "p-2026-11-acme-1",
"e": "shown", "p": "/" }`, where `e` is `shown` (the box was at least half on screen, once per page load)
or `open` (its posting link was pressed, once per page load). It adds one to `placement_counts` for the
UTC day, the placement, the page kind (`dashboard` or `landing` only) and the event, and only when that
placement is `on` and inside its dates today, so a made-up or ended id adds nothing. Nothing else is
sent or stored: no listing, filter, search, profile or anything about the visitor. The same Origin,
crawler and per-minute checks apply, under a separate cap of 50,000 a day. Daily rows older than 400
days are folded by the daily cron into one row per month (`day` = `YYYY-MM`). The counts can be forged,
so they are estimates and never the basis of a price.

### `POST /employer-interest` (site only, no auth)
The interest form on `internscout.org/employers/` (added 2026-10-13; `src/leads.js`). Body (JSON, at most
8,000 bytes):
`{ "name": "...", "email": "...", "company": "...", "title": "", "hiring_for": "", "wants": ["placement", "board", "details", "other"], "message": "", "website": "" }`.
`name` (100), `email` (254, must look like an address) and `company` (120) are required; `title` (100),
`hiring_for` (300) and `message` (2,000) are optional. Lengths are counted after trimming. `wants`
holds the form's boxes: `placement` (a paid listing for one open role), `board` and `details` (free: add a job board, correct a company's details) and `other`.
The first form's `featured`, `promoted` and `majors_schools` (until 2026-10-14) are still accepted, so a
cached page still sends, but are no longer offered. Unknown `wants` values are dropped. The stored value
is a comma list in the order above, old values first. `website` is a honeypot the page hides: when it is filled the answer is the
same `200 { "ok": true }` and nothing is stored. A good send is stored in `employer_leads` and counted as
the server step `employer_interest` (page `employers`) in `event_counts`; answers `200 { "ok": true }`.
`400 bad_request` with `"field"` naming the first field at fault; `403` unless `Origin` is the live site
(a local copy of the site cannot write a lead); `429 rate` (with `retry_after`) after 5 sends from one
address in a UTC day (counted in `rate` under a salted hash of the address) or 100 from everyone.
No IP address is stored with a lead. The daily cron deletes leads older than a year.
Read them: `npx wrangler d1 execute internscout --remote --command "SELECT * FROM employer_leads ORDER BY created DESC"`.

### `GET /demand` (CI only)
Needs `Authorization: Bearer <DEMAND_TOKEN>` (a secret). Returns:
```json
{ "states": { "MA": 12, "NY": 5 }, "users": 17, "updated": "2026-09-14T00:00:00Z" }
```
Only users active in the last 90 days count. The ingest workflow reads this with the repo secrets
`INTERNSCOUT_DEMAND_URL` + `INTERNSCOUT_DEMAND_TOKEN` and passes the state codes to the backend as
`INTERNSCOUT_WANTED_STATES`.

## Placements (paid listings; off until `ADMIN_TOKEN` is set)

Added 2026-10-14 (`src/placements.js`). The record of which listing an employer paid to show in a
separate, labelled box, and on which days. Payment never changes any score, order, filter, count or
Auto-Apply behaviour: a placement only names a listing by its pipeline id (`listing_id`, 16 lowercase
hex characters) and nothing is ever added to a listing. There is no payment code here. Bruce invoices
from his own Stripe dashboard and records `"pilot"` or the invoice number as `paid_ref` when he
switches a placement on. Days are UTC `YYYY-MM-DD`; `start` is the first day shown and `end` the first
day it no longer shows.

A placement moves through `draft` → `checked` (every sponsor check recorded) → `on` ⇄ `paused`, and ends
as `ended` (by hand, or by the daily cron once `end` has come, with `ended_reason: "dates"`) or
`refused`. Every change writes one `placement_log` row with the row as JSON before and after.

### `GET /placements` (public, for the site build)
No auth. Returns the placements that are `on`, whose `end` is after today and whose `start` is today or
tomorrow at the latest (so an evening build carries one that starts at midnight):
```json
{ "day": "2026-11-03", "placements": [ { "id": "p-2026-11-acme-1", "listing_id": "3f9c0a1b2c3d4e5f",
  "apply_url": "https://...", "employer": "Acme", "start": "2026-11-01", "end": "2026-12-01", "page_cap": 1,
  "unpaid_ok": 0 } ] }
```
Exactly those keys: never `paid_ref`, `note`, `lead_id`, `checks` or who changed what. `unpaid_ok` (added
2026-10-14) is `1` when Bruce confirmed a nonprofit or government role (`check` with `unpaid_ok: true`); the
site build keeps a placement whose listing says it is unpaid only then (backend `placements.resolve`).
`Cache-Control: public, max-age=300`. The site build reads it once per deploy; visitors never call it.

### Admin routes (Bruce's terminal only)
`worker/scripts/placement.mjs` wraps them. Every admin route:
- answers `404 not_found` while the `ADMIN_TOKEN` secret is unset, as if it did not exist;
- answers `403 forbidden` to any request that carries an `Origin` header, even with the right token,
  so no web page can call it (CORS never applies);
- answers `401 auth` without `Authorization: Bearer <ADMIN_TOKEN>` (compared in constant time).

POST bodies are JSON objects of at most 4,000 bytes. Every change takes `by`, a short label such as
`"bruce"` (letters, digits, `-` and `_`; never an email). The id goes in the body because the router
matches exact paths. Changes answer `200 { "placement": { ...the full row } }`; `400 bad_request` with
`"field"` for a bad value, `404` for an unknown placement or lead, and `409 conflict` for a step the
current status does not allow (or a row that changed while it was being saved).

| Route | Body | Does |
|---|---|---|
| `GET /admin/placements` | none | `{ placements: [...] }`: every row with its private fields, plus `log`, its last 20 log entries, newest first, and (added 2026-10-14) `runs`, `{ days_shown, days_dropped, drops: [{ day, reason }] }`, from `placement_runs`: the UTC days a site build kept the placement, and the days one dropped it while it was live (`dropped > 0`) with the latest reason. The pages workflow writes that table after each build (`backend/internscout/placements.py` `record_runs`, over the D1 HTTP API); drops for `dates` (not started yet) and `duplicate` are not recorded. |
| `GET /admin/leads` | none | `{ leads: [{ id, created, company, wants }] }`, the 100 newest employer leads, without name, email or message. |
| `POST /admin/placements` | `{ lead_id?, employer?, listing_id, apply_url, start, end, note?, by }` | Creates a `draft` with an id like `p-2026-11-acme-1`. With `lead_id` the lead must exist, and its company is the employer unless `employer` is given; nothing else is copied from the lead. `apply_url` must be `https://`; `end` must be after `start` and at most 62 days later. |
| `POST /admin/placements/update` | `{ id, by, start?, end?, listing_id?, apply_url?, employer?, note? }` | In `draft`, `checked` or `paused`: any of those. A new `listing_id` or `apply_url` clears the checks and sends it back to `draft`. While `on`: only a later `end` and `note`. |
| `POST /admin/placements/check` | `{ id, by, checks: [...], unpaid_ok? }` | From `draft` or `checked`. Records the sponsor checks and the day. Becomes `checked` only if every check is present, otherwise `draft`. Checks: `role_on_employer_site`, `email_domain`, `pay_range_where_required`, `paid_or_public_body`, `min_age_if_hs`, `not_hazardous_for_minors`, `no_fee_no_early_data`, `no_targeting_asked`. `unpaid_ok: true` only for a nonprofit or government role Bruce confirmed. |
| `POST /admin/placements/on` | `{ id, by, paid_ref }` | From `checked` or `paused` only, with a non-empty `paid_ref` (`"pilot"` or the invoice number), and only while `end` is still ahead. |
| `POST /admin/placements/pause` | `{ id, by, reason }` | `on` to `paused`. |
| `POST /admin/placements/end` | `{ id, by, reason }` | Any status not yet `ended` or `refused` to `ended`. `reason` is one of `dates`, `role_closed`, `listing_gone`, `removed`, `refunded`. The emergency stop. |
| `POST /admin/placements/refuse` | `{ id, by, reason }` | `draft` or `checked` to `refused`. |
| `POST /admin/placements/report` | `{ id, month }` | The employer report (added 2026-10-14, S9) for one calendar month that has ended (`YYYY-MM`; the month still running is refused): `{ report: { placement, employer, listing_id, month, shown, opened, by_page, about } }`. `shown` and `opened` are text, rounded down to the nearest 10 (`"1,230+"`), or `"fewer than 10"`. `by_page` splits them by `dashboard` and `landing` only when every number in the split is 10 or more, otherwise `null`. Raw counts are never returned. `about` is the plain-English note for the employer: what the numbers are and are not. |

## Paid listing orders (bought on the site; off until `EMPLOYER_CHECKOUT` is `"1"`)

Added 2026-10-19 (`src/orders.js`, `src/mail.js`; the design is `worker/ORDERS.md`). An employer buys a
paid listing for 1 or 3 of its open roles on `internscout.org/employers/buy/`; Bruce approves or refuses
each order from a signed link in his email. Approving runs the same placement steps as the admin routes
above (`update` if the start day has passed, `check` with all eight checks, `on`), by `"bruce"`, so every
placement rule and log entry still applies.

Every route below answers `404 not_found` unless `EMPLOYER_CHECKOUT` is `"1"` **and** `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `REVIEW_TO` and `ORDER_FROM` are set **and** the `EMAIL` email
binding exists. The one exception is `GET /employer/config`, which then answers `enabled: false`.
"Site only" routes answer `403` unless `Origin` is `https://internscout.org` (or the github.io origin).
JSON bodies are at most 4,000 bytes.

Prices in cents: `one` (1 role) 2900, or 1500 for a nonprofit or public body; `three` (3 roles of one
employer) 6900, or 3500. Each role runs 30 days. At most 5 paid roles at once share a field tag (a role
with no field tags counts under `other`); the cap counts roles of paid or approved orders while their
placements are `draft`, `checked`, `on` or `paused`, and roles of a verified order for 35 minutes after its
Checkout opened, and placements made by hand with `scripts/placement.mjs` while `draft`, `checked`, `on` or
`paused`, under their role's fields from the role index (`placement_fields`; "other" until looked up).
The start day is today up to 90 days ahead (UTC days).

The roles come from the site's role index, `SITE_URL/data/roles/<shard>.json` (`shard` is one of `a`-`z`,
`0`-`9`, `_`, the first character of the employer key), shaped
`{ generated, roles: [{ id, k, co, t, loc, u, f: [...], unpaid }] }`. A role qualifies only if it is in
that file today with an `https://` apply link; a role with `unpaid: true` only for a nonprofit or public
body. `502 roles_unavailable` when the file can't be read (a missing shard file is an empty shard).

### `GET /employer/config` (no auth)
`{ "enabled": true, "prices": { "one": { "roles": 1, "cents": 2900, "public_body_cents": 1500 }, "three": { "roles": 3, "cents": 6900, "public_body_cents": 3500 } }, "days": 30, "field_cap": 5, "max_start_days": 90, "terms_version": "2026-10-19" }`.

### `GET /employer/availability?shard=&ids=&start=` (no auth)
`ids` is 1 to 20 role ids (16 lowercase hex), comma separated; `start` defaults to today. Each role on its
own: `{ "start": "...", "roles": [ { "id", "listed": true, "fits": true } | { "id", "listed": true, "fits": false, "full": ["engineering"], "taken": true, "next_start": "YYYY-MM-DD" } | { "id", "listed": false } ] }`.
`full` and `taken` appear only when they apply. `taken` means the same role is already paid for on some
of those days. `next_start` is the first day it would fit (it can be past the 90-day window).

### `POST /employer/order` (site only)
`{ "shard": "a", "roles": ["<id>", ...], "package": "one" | "three", "start": "YYYY-MM-DD", "name": "...", "email": "...", "company": "...", "public_body": false, "terms": true, "pilot_code": "", "website": "" }`.
`name` (100), `email` (254) and `company` (120) are required; the email may not be at a free webmail domain
(gmail.com, outlook.com and the like). `terms` must be `true`; the order stores the terms version and the
time. `roles` must be exactly the package's number of distinct ids, all listed today, all of one employer.
`website` is a honeypot: filled, the answer is the same and nothing is stored. A good order is stored as
`unverified` and a link (`SITE_URL/employers/buy/?order=ID&t=TOKEN`, valid 48 hours, stored only as a
SHA-256) is emailed to the work address. Answers `200 { "ok": true }`.
Errors: `400 bad_request` with `field`; `409 full` with `roles` (those that don't fit) and `next_start`
(the first start day on which the whole order fits); `429 rate` (with `retry_after`) after 5 orders from
one address in a UTC day or 100 from everyone; `502 mail` if the email could not be sent (the order is
then not kept).

### `POST /employer/order/confirm` (site only)
`{ "order": "o-...", "token": "..." }` from the emailed link. `403 link` for a wrong, expired or other
order's token. The order becomes `verified`, and the field cap is checked again (`409 full`). With a
pilot code it becomes `paid` at once and the answer is `{ "done": "pilot" }` (`409 pilot_used` if the code
was taken since). Otherwise `{ "url": "https://checkout.stripe.com/..." }`: a Checkout session in
`payment` mode for the order's price (`price_data`, USD), `customer_email`, `client_reference_id` = the
order id, `metadata` and `payment_intent_data[metadata]` `{ kind: "listing", order }`, an invoice
(`invoice_creation[enabled]`), promotion codes allowed, expiring after 31 minutes, returning to
`SITE_URL/employers/buy/?paid=ID` or `?cancelled=1`. Never Managed Payments. Asked again within 30 minutes
it hands back the same session. An order that is already paid answers `{ "done": "paid" }`.

### Payment (`POST /billing/webhook`)
The existing Stripe endpoint. It is on when the student plans are on **or** the orders are on. Handled
before anything about student plans, which are unchanged:
- `checkout.session.completed` and `checkout.session.async_payment_succeeded` with `metadata.kind =
  "listing"`: when `payment_status` is `paid` or `no_payment_required` the order becomes `paid` (`paid_ref`
  `stripe:pi_...`), one `draft` placement per role is made (`created_by` `"checkout"`), Bruce gets the
  review email and the employer a "received" email. `unpaid` waits for the async event. A second paid
  session for an order already paid is refunded in full automatically (and both are told).
- `charge.dispute.created` on an order's payment: its live placements are paused (by `"stripe"`) and Bruce
  is emailed. `charge.refunded` on an order's payment is ignored (the order already records its refunds).

An email that fails never undoes the payment record; the daily cron sends a missing review email again.

### `GET /employer/review?order=&sig=` (Bruce, from the email)
`sig` is the hex HMAC-SHA256 of `"review:" + order id` under `ADMIN_TOKEN`, compared in constant time
(`403` otherwise). Answers a self-contained HTML page: no script, a strict `Content-Security-Policy`
(`default-src 'none'`, the one style block by hash, `form-action 'self'`), `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`. It shows the order, the verified email and its domain beside the apply
link hosts, the nonprofit claim, the roles as the role index lists them right now, the field counts and
the dates, and two forms.

### `POST /employer/review` (Bruce, that page)
`application/x-www-form-urlencoded`: `order`, `sig`, `action` (`approve` or `refuse`), `reason` (refuse
only, required, at most 200 characters). Only a `paid` order can be decided (`409` otherwise).
- `approve`: if the start day has passed the placements move to today + 30 days; all eight checks are
  recorded by `"bruce"` (`unpaid_ok` for an unpaid role of a public body), every placement is switched on
  with the order's `paid_ref`, the order becomes `approved` and the employer is emailed the dates. Refused
  while a payment dispute is open.
- `refuse`: the full amount is refunded through Stripe (idempotency key per order), the placements become
  `refused`, a pilot code is freed, the order becomes `refused` and the employer is emailed the reason.

Answers a plain HTML page.

### `GET /employer/credit?credit=&t=` (employer, from the email)
When the daily cron ends a placement because every site build dropped its role on both of the last two
days (`placement_runs` reasons `listing_gone`, `closed`, `url_changed`, `deadline`), the unused days
(from the first such day), times the role's share of what was paid, over 30, are offered back by email.
Answers `{ credit, status: "offered" | "refund" | "credit", amount, unused_days, role: { title, company }, choose_by, code }`
(`code` only once a promotion code was chosen); `403 link` for a wrong token.

### `POST /employer/credit` (site only)
`{ "credit": "c-...", "token": "...", "choice": "refund" | "credit" }`. `refund`: that amount is refunded
on the order's payment; answers `{ "done": "refund", "amount" }`. `credit`: a Stripe coupon (`amount_off`,
USD, `duration` once, `max_redemptions` 1) and a promotion code for it (`max_redemptions` 1, for an order of
at least $15 so it can't be spent on a student plan); answers `{ "done": "credit", "code", "amount" }`.
`409 decided` once chosen. No answer in 30 days: the daily cron refunds it.

### Order admin routes (Bruce's terminal)
The placement admin rules apply: `404` without `ADMIN_TOKEN`, `403` with an `Origin`, `401` without the
token. Not tied to `EMPLOYER_CHECKOUT`, so pilot codes can be made before buying opens.

| Route | Body | Does |
|---|---|---|
| `GET /admin/orders` | none | `{ orders: [{ id, created, status, package, start, amount, company, roles }] }`, the 100 newest; never the name or email. `amount` is what was paid, else the list price, in cents. |
| `POST /admin/pilot-codes` | `{ note? }` | `{ code, note, created, made, max }`: a new pilot code such as `PILOT-7KQ2M9XA`; `409` once 5 have ever been made. |

### The daily cron
Deletes orders never confirmed after 7 days (always, even while orders are off). While on: sends a review
email that failed, reminds Bruce once about an order waiting more than a day, ends closed roles and makes
the offer above, sends an offer email that failed, and refunds offers unanswered after 30 days.

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
subscription and put the student back on free. Anything else is ignored. Since 2026-10-19 events about
paid listing orders are handled first and never touch a plan (see "Paid listing orders" above).

The tier comes from the subscription's price id rather than its metadata, because a student who
switches tier inside Stripe's portal keeps the metadata the original checkout wrote. Metadata is only
the fallback when no price matches a known tier.

In the Stripe dashboard the endpoint URL is `<worker-url>/billing/webhook`.

## Worker secrets and vars
- **Secrets** (Bruce sets them with `wrangler secret put`):
  - `GEMINI_API_KEY`
  - `HASH_SALT`
  - `DEMAND_TOKEN`
  - `ADMIN_TOKEN`: any long random string. Turns on the placement admin routes (404 while unset). Its
    own secret, not `DEMAND_TOKEN`, because that one is also stored in GitHub's CI secrets. Kept on
    Bruce's machine as `INTERNSCOUT_ADMIN_TOKEN` for `scripts/placement.mjs`, and nowhere else.
  - `PROFILE_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts saved Deep Dives.
    Unset, the `/profile` routes answer `503 sync_off`. Replacing it makes every saved copy unreadable
    (each is replaced on that student's next save), so set it once and keep it.
  - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (Supporter), `STRIPE_PRICE_ID_PRO` (Pro),
    `STRIPE_WEBHOOK_SECRET`: only for the paid plans (the key and webhook secret also for listing orders)
  - `REVIEW_TO` (2026-10-19): where the paid listing review emails go, and the reply-to of employer emails
- **Vars:**
  - `GOOGLE_CLIENT_ID`, `MS_CLIENT_ID` (a provider is off while its ID is empty)
  - `EDU_EXTRA_DOMAINS` (comma list of non-`.edu` school domains, default empty), `GENERAL_ALLOWANCE_PCT` (default 50)
  - `ALLOWED_ORIGINS`
  - `MONTHLY_BUDGET_CENTS` (default 7500)
  - `GLOBAL_RPM` (AI calls per minute across everyone, default 120; `"0"` turns AI off)
  - `PAYMENTS_ENABLED` (`"0"` by default), `SUPPORTER_PRICE_TEXT` and `PRO_PRICE_TEXT` (display only),
    `SITE_URL` (where Stripe returns to, and where the role index is read)
  - `EMPLOYER_CHECKOUT` (`"0"` by default; `"1"` turns on the listing orders), `ORDER_FROM` (their sender),
    `API_URL` (optional: the Worker's own address in the review links; default the workers.dev one)
- **Email binding** (2026-10-19): `EMAIL` (`[[send_email]]`, Cloudflare Email Sending), for the listing
  orders only; commented out in `wrangler.toml` until internscout.org is onboarded.
<!-- was: - **D1 binding:** `DB`, with tables `usage`, `runs`, `rate`, `demand`, `budget`, `plans`, `stripe_events`. -->
- **D1 binding:** `DB`, with tables `usage`, `runs`, `rate`, `demand`, `budget`, `spend`, `tokens`, `forget`,
  `plans`, `stripe_events`, `invite_codes`, `referrals`, `bonus`, `accounts`, `inviters`, `sessions`, `profiles`,
  `task_tokens`, `visit_counts`, `visit_channels` (social visits by site; added 2026-10-05), `event_counts`
  and `run_hist` (calls per run, by month, task and bucket, kept by the daily cron when it drops a past
  month's `runs`; added 2026-10-04), `employer_leads`, and `placements` and `placement_log` (paid listings
  and their change history; added 2026-10-14), and `employer_orders`, `employer_order_roles`,
  `employer_credits` and `pilot_codes` (listings bought on the site; added 2026-10-19). The schema is in `worker/schema.sql`.

## Dashboard ↔ extension bridge
- The existing bridge (`extension/bridge/bridge.js`) relays `{__internscout:"req", id, msg}`. The background worker handles it by `msg.type`.
- **New message types:**
  - `{type:"profile:set", profile:{majors, minors, class_year, grad_term, stages, terms, states, work_auth}}` returns `{ok:true}`. The extension stores `majors`, `class_year` and `grad_term` in `profile.facts`.
  - `{type:"profile:get"}` returns `{profile}`.
  <!-- was: - `{type:"auth:token"}` returns `{token}` or `{token:null}`. The dashboard can reuse the extension's sign-in. -->
  - `{type:"auth:token"}` returns `{token, email, account, expires}` (`expires` in ms since the epoch)
    when the extension holds a session, `{token}` for a legacy ID token, or `{token:null}`. The dashboard
    can reuse the extension's sign-in, and accepts both shapes.
  - `{type:"auth:offer", token}` (2026-10-14) offers the dashboard's own session token to an extension
    that is signed out. Only from https://internscout.org (or a local copy on an unpacked build); only a
    session token. The extension checks it with `GET /session` and keeps it aside for a few minutes; it
    is used only if the student presses "Use my dashboard sign-in" in the extension. Returns `{ok:true}`
    or `{ok:false}` and nothing else.
