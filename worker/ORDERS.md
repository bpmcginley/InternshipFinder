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
   and company, ticks the terms box (clickwrap: we store the terms version, the box's exact words and the time) and
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

- Every paid listing counts against `FIELD_CAP`, however it was bought (the terms promise it). A
  placement made by hand with `scripts/placement.mjs` gets its role's fields from the role index
  (`placement_fields`), right after the admin route and again in the daily cron if that missed it.
  was (until legal review round 4): hand-made placements had no field tags and did not count.
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
6. Only after the lawyer has approved the terms and privacy changes on the same PR (done 2026-10-19,
   round 4).
7. On the day the terms change goes live, `TERMS_VERSION` in `src/orders.js` must equal the terms page's
   "Last updated" day (a site test fails otherwise), and that version is tagged so the link in the
   "received" email works: `git tag terms-YYYY-MM-DD <merge commit>` and `git push origin terms-YYYY-MM-DD`.

## Cancelling before approval

The terms let an employer cancel an order by email for a full refund until it is approved. The
"received" email says to reply. Bruce opens the order's review link and uses **Refuse** with the reason
"Cancelled at your request": that refunds in full and emails the employer, the same as any refusal.

For a verified request to remove a contact name/email early, follow
[ORDER_CONTACT_REMOVAL.md](ORDER_CONTACT_REMOVAL.md). Resolve ongoing placements and compensation,
stop pending email delivery, and invalidate links before clearing contact fields; retain the required
financial record. Do not delete a sale or leave a queued email containing the removed contact data.

Pilot allocation: the owner requested five unassigned single-use codes for the first five employer
buyers, not codes tied to preset companies. Keep the codes private and allocate one per employer.
Creating a code does not automatically apply it to an order or send it to anyone.

## Financial safety and reconciliation (October 19 review)

Apply the complete `schema.sql` before enabling the Worker. New tables are additive; no existing
table is rebuilt. The order email schema is included in it, so a separate manual SQL append is not
needed after this revision.

- `employer_capacity_reservations` reserves field/listing/day combinations atomically before a
  Stripe Checkout is opened. The database trigger enforces five per field and prevents another
  order holding the same role/day. The all-or-nothing reservation uses `json_each` with two bound
  parameters, including three roles with twenty fields each; it does not generate one bound SQL
  statement per role/day. Changing `FIELD_CAP` also requires changing the database trigger.
- Checkout holds expire after 35 minutes. Paid orders have permanent reservations. A delayed bank
  payment is still recorded and sent for review if its old hold expired and the dates filled; the
  owner must choose dates with room or refuse/refund it. Approval reserves shifted dates again
  before switching on any placement. It cannot silently overbook when review takes several days.
- Free pilot claims are idempotent for their own order and use temporary capacity before payment
  is recorded. An unpaid interrupted claim is released when its confirmation link expires. A code
  used by another order creates no permanent capacity hold.
- `employer_decisions` records one immutable approve/refuse claim before any external effect. A
  concurrent opposite click is refused. A capacity failure before approval changes anything releases
  its claim, allowing refusal. Other incomplete outcomes remain held for reconciliation.
- `employer_credit_jobs` records one immutable refund/credit choice before calling Stripe. A timeout,
  malformed response, database failure after provider acceptance, or interrupted process cannot
  switch choices or blindly repeat a payout. The amount owed remains in `employer_credits`; an
  unresolved job is `running` or `unknown`, not a completed refund. The offer's GET response includes
  `processing`, and another choice POST is refused. Disputed or refused orders also require review.
- The daily cron emails the owner once for unknown operations or claims running for over fifteen
  minutes, retrying that alert if sending failed. This does **not** mean a fifteen-minute scheduler
  exists; the alert happens at the next daily cron. The system prioritizes avoiding duplicate money
  movements over automatically retrying an uncertain result after Stripe's idempotency window.
- Closing a role and recording its unused-day credit are one transaction. A failed credit insert
  rolls back the end, so the next cron can retry. Ordinary date expiry running first cannot erase a
  credit for the last two unused days. Bundle prices allocate remainder cents once, so a $35 bundle
  can never offer $35.01 back across its three roles.
- The employer's thirty-day choice window starts with the successfully sent offer email, not an
  earlier failed attempt or the credit's creation date. An offer that never sent is not default-refunded
  by a timer the employer never received.

### Manual maintenance while checkout is open

All existing manual placements count toward capacity using `placement_fields`; their reservations
are read from the database in the same transaction as a new order's reservation. Direct legacy
`/admin/placements/on` and `/admin/placements/update` requests return **409 manual_capacity_hold**
while employer checkout is enabled. Those writes do not share the reviewed order transaction, so a
read-before-write cap check would still race with a buyer's Checkout. This is an intentional launch
restriction, not an assertion that legacy manual activation is now transaction-safe.

Read-only admin routes, creating drafts, pilot-code commands, and emergency pause/end/refuse remain
available. Self-service orders activate through their reserved review flow. For manual activation or
date/listing changes, the owner must first pause new checkout and reconcile outstanding Checkout
sessions and paid orders, then verify the combined field capacity before maintenance and reopening.
Do not merely toggle checkout off while someone still has a payable session. Stopping a placement
does not require this maintenance window.

### An operation is held or unknown

Do not clear a claim, choose the opposite action, rerun a payout, or assume that an HTTP error means
no money moved. The owner should inspect the private order and financial-job records, the placement
log, and Stripe's payment/refund/coupon/promotion records using the order/credit metadata and recorded
idempotency keys. The keys are operation identifiers, not secrets.

Read-only starting points through the existing authorized D1 access:

```sql
SELECT order_id, action, state, created, updated, alerted_at
FROM employer_decisions WHERE state != 'done';
SELECT credit_id, order_id, choice, state, created, updated, alerted_at
FROM employer_credit_jobs WHERE state != 'done';
```

If Stripe accepted the operation, reconcile its returned reference and the matching final database
state; do not create a second payout. If it definitively did not, prepare and review a recovery for
that same choice. There is deliberately no public endpoint that resets a financial claim. A database
write failure or process interruption may require owner intervention; money owed is retained rather
than silently discarded. A promotion code/refund result is not proof the employer's notification
arrived or a bank has completed settlement.

Receipt and decision emails use a durable outbox. Decisions are persisted before final state changes
but dispatched only after the matching state commits; an uncommitted or disputed approval cannot
announce success. Failed sends retry in the daily cron. Successful sends erase the message's contact
details/body from the outbox and keep its small idempotency record. Provider acceptance followed by
a process interruption can still duplicate a notification; this is retryable delivery, not an
exactly-once guarantee. Review responses say the notice is recorded for delivery, not that it arrived.
Confirmed order contacts, credits, related jobs and pending mail are removed after seven calendar
years by the existing daily cron, including while new checkout is off. Anonymous placement history
retains its existing policy.
