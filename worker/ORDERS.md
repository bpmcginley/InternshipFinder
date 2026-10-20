# Buying a paid listing on the site (self-serve orders)

Added 2026-10-19. Before this, Bruce invoiced every paid listing from his Stripe dashboard and switched it
on with `scripts/placement.mjs`. Now an employer can buy one on internscout.org/employers/buy/. Bruce
still makes one decision per order: a single Approve or Refuse click. Everything else is automatic.

Decisions (Bruce, 2026-10-19): prices final; one-click approval; a free pilot for the first five
employers; refunds automatic on refusal, and the unused days back when a role closes early (the employer
chooses credit or refund, as terms.html#employers says). No bidding: a cap of paid listings per field
instead, with "full until" dates.

The whole feature is OFF until `EMPLOYER_CHECKOUT = "1"` and its secrets and the email binding are set
(see "Turning it on"). While off, every `/employer/*` route except `GET /employer/config` answers 404 and
the buy page says buying on the site is not open yet.

## Prices and limits (worker/src/orders.js)

| Package | Roles | Days each | Price | Nonprofit or public body |
|---|---|---|---|---|
| `one` | 1 | 30 | $29 | $15 |
| `three` | 3 (same employer) | 30 | $69 | $35 |

- `FIELD_CAP = 5`: at most 5 paid roles running at once that share a field tag (a listing's
  `field_tags`; a listing with none counts under `other`). A role whose dates would make any of its
  fields go over 5 is refused at order time with the first day it would fit (`next_start`).
- Start day: today up to 90 days ahead. If Bruce approves after the start day, the dates shift to
  approval day + 30, so no paid day is lost to the review.
- A role qualifies only if InternScout lists it today as open (the site's role index, below). A role
  whose posting doesn't say it is paid qualifies only for a nonprofit or public body.
- Free webmail addresses (gmail.com, outlook.com and the like) are refused: the terms say "you write
  from your company's domain".

## The flow

1. **Order** (`POST /employer/order`, the site's Origin only, honeypot, per-address daily limit like
   the interest form). The employer picks 1 or 3 of its open roles, a start day, gives name, work email
   and company, ticks the terms box (clickwrap: we store the terms version and the time) and
   optionally enters a pilot code. The Worker re-reads the roles from the site's role index, checks
   the rules above and stores an `unverified` order. It emails a link to the work address. The link
   works for 48 hours.
2. **Confirm the email** (`POST /employer/order/confirm` from the buy page the link opens). The order
   becomes `verified`. With a pilot code it is `paid` at once (`paid_ref` "pilot:CODE"). Otherwise the
   Worker opens a Stripe Checkout session (payment mode, an invoice is created, 31 minutes to pay) and
   the page goes there.
3. **Paid** (Stripe webhook `checkout.session.completed` or `checkout.session.async_payment_succeeded`
   with `metadata.kind = "listing"`, on the existing `/billing/webhook`). The order becomes `paid`, one
   draft placement per role is created (`created_by` "checkout"), Bruce gets a review email and the
   employer gets a "received, we review within 2 business days" email.
4. **Review** (the link in Bruce's email: `GET /employer/review?order=ID&sig=HMAC`). A plain page with
   everything needed for the checks: the roles as InternScout lists them right now, the apply links,
   the verified email and its domain against the job board, the nonprofit claim, the field counts, the
   dates. Two buttons:
   - **Approve**: records all eight sponsor checks as done by Bruce, sets `unpaid_ok` where it applies,
     switches every placement on (`paid_ref` "stripe:pi_..." or "pilot:CODE") and emails the employer
     the dates. The site build picks it up on its next run.
   - **Refuse** (a reason is required): refunds the full amount through Stripe, marks the placements
     `refused`, frees a pilot code, and emails the employer the reason.
   A reminder goes to Bruce once if an order waits more than a day.
5. **Role closes early** (daily cron). A live placement that every site build dropped on both of the
   last two days, for `listing_gone`, `closed`, `url_changed` or `deadline` (placement_runs, written by
   the build), ends with reason `role_closed`. The unused days (from the first dropped day) times the
   role's share of the price, over 30, is offered to the employer by email: a refund of that amount or
   a one-time Stripe promotion code worth it. No answer in 30 days means a refund. A pilot has nothing
   to refund and the employer is told it stopped.

A payment dispute pauses the order's placements and emails Bruce. Pausing or ending a listing for any
other reason, and its refund, stay manual (`scripts/placement.mjs`, the Stripe dashboard).

## Data (worker/schema.sql)

- `employer_orders`: one row per order. Private: name, email, company typed, the terms version and
  time accepted, the Stripe session and payment intent, amounts. Kept 7 years as the business record
  of a sale (privacy.html#employers); an order never confirmed is deleted after 7 days. The email link
  is stored only as a SHA-256 hash.
- `employer_order_roles`: the roles of an order as the role index showed them, and the placement made
  for each.
- `employer_credits`: an unused-days offer and what the employer chose.
- `pilot_codes`: at most 5 ever (`PILOT_MAX`), made with `node scripts/placement.mjs pilot-code`.

## The role index (the site build)

`backend/internscout/role_index.py`, called by `seo_pages` on every Pages build, writes
`/data/roles/index.json` (each employer with open roles: key, name, count, shard) and
`/data/roles/<shard>.json` (that shard's open roles: id, employer key, company, title, location,
apply URL, field tags, whether the posting says it is unpaid). The shard is the first character of
the employer key (`a`-`z`, `0`-`9`, else `_`). The buy page searches it; the Worker reads the same file
from `SITE_URL` to check every role it is sent, so a buyer can't name a role, link or field we don't
list.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /employer/config` | anyone | `{enabled, prices, days, field_cap, max_start_days, terms_version}` |
| `GET /employer/availability?shard=&ids=&start=` | anyone | per role: fits, or the full fields and `next_start` |
| `POST /employer/order` | site only | creates an unverified order, emails the link |
| `POST /employer/order/confirm` | site only | `{order, token}` -> `{url}` (Stripe) or `{done: "pilot"}` |
| `GET /employer/review?order=&sig=` | Bruce (email link) | the review page |
| `POST /employer/review` | Bruce (that page) | approve or refuse |
| `GET /employer/credit?credit=&t=` | employer (email link) | the offer |
| `POST /employer/credit` | site only | `{credit, token, choice: "refund" or "credit"}` |
| `GET /admin/orders` | Bruce's terminal | recent orders, without email or name |
| `POST /admin/pilot-codes` | Bruce's terminal | a new pilot code (at most 5 ever) |

## Details settled while building it (2026-10-19)

- Only roles of orders bought here count against `FIELD_CAP`. A placement made by hand with
  `scripts/placement.mjs` has no field tags, so it does not count.
- The same role can't be bought twice for overlapping days (`taken`, with `next_start`).
- An order that was confirmed but never paid is kept like any order: its Checkout may still be a bank
  payment on its way. Only `unverified` orders are deleted after 7 days.
- A promotion code made for unused days works once and only on an order of at least $15, so it can't be
  spent on a student plan (their Checkout also takes promotion codes).
- `GET /admin/orders` and `POST /admin/pilot-codes` need only `ADMIN_TOKEN`, so pilot codes can be made
  before buying opens.
- The review link points at the Worker's workers.dev address; the optional var `API_URL` changes it.

## Turning it on

1. Cloudflare dashboard: Compute > Email Service > Email Sending > Onboard Domain > internscout.org.
   Sending to any address needs the Workers Paid plan ($5 a month).
2. In `wrangler.toml`, uncomment the `[[send_email]]` block, and set `EMPLOYER_CHECKOUT = "1"`.
3. `wrangler secret put REVIEW_TO` (the address review emails go to; also the employer emails'
   reply-to). `ADMIN_TOKEN` signs the review links, so it must be set already.
4. Stripe: the existing webhook endpoint already sends `checkout.session.completed`; add
   `checkout.session.async_payment_succeeded` and `charge.dispute.created` if they are not on it.
5. `npm run deploy`, then `node scripts/placement.mjs pilot-code --note "first pilot"` for each pilot.
6. Only after the lawyer has approved the terms and privacy changes on the same PR.
