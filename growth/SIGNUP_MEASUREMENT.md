# Weekly email signup measurement

The success measure is **25 confirmed, non-test subscribers** in the intended student audience.
Form submissions are a diagnostic, not the success count. Do not publish a student count unless
there is evidence those subscribers are students; a confirmed address alone does not establish that.

## Current launch state

The owner approved the final preview and activation on October 15, 2026. Forms are live and the
weekly job is enabled, with its first scheduled send Monday, October 19 at 12:00 UTC (8 a.m. Eastern
in daylight time, 7 a.m. in winter; GitHub can start late). See `MuseWork.md` for launch verification.
There is no new broadcast or test subscription required to use this measurement procedure.

## Three different numbers

| Measure | Source | What it establishes |
|---|---|---|
| Invitation exposure | D1 `digest_view_<placement>` | At least 25% of that invitation intersected the viewport, once per placement per page load. A form merely mounted below the list does not count. |
| Link click / form submission | D1 `digest_click_<placement>` / `digest_submit_<placement>` | Someone pressed a marked link or the browser dispatched a valid form submit. This does not prove Buttondown accepted it, delivered the confirmation, or activated the subscriber. |
| Active confirmed subscribers | Buttondown subscriber status, checked manually in aggregate | Addresses that completed confirmation and remain subscribed. Exclude owner/test accounts. Pending, unsubscribed and suppressed accounts do not count toward the target. |

The existing `digest_signup` event retains its old meaning: **form submissions, once per page load
across all forms**. Label it "Weekly email form submissions" in the private analytics page, not
"Subscribers" or "Confirmed signups". That private Claude page is outside this repository; its
owner must apply the label there. Never add `digest_signup` to the placement submission totals.

## Read the anonymous funnel

After deploying the Worker whitelist and site changes, run this read-only query through the existing
private D1 access. Deploy the Worker first; before its whitelist is deployed, new event names are
ignored. No database migration, new credentials or provider plan is needed.

```sql
SELECT event, page, SUM(n) AS page_load_events
FROM event_counts
WHERE day >= date('now', '-6 day')
  AND (event = 'digest_signup'
       OR event LIKE 'digest_view_%'
       OR event LIKE 'digest_click_%'
       OR event LIKE 'digest_submit_%')
GROUP BY event, page
ORDER BY event, page;
```

Finite placements are `nav`, `results_inline`, `footer`, `contextual`, `digest_page` and `landing`.
HTML uses `data-digest-placement="results-inline"` / `"digest-page"`; event names replace hyphens
with underscores. `nav` and `contextual` invitations link to `/digest/`; their clicks are not form
submissions. The destination's form counts under `digest_page`, without claiming which earlier link
caused the later confirmation. Untagged legacy forms still contribute only to `digest_signup`.

For each form placement, compare submissions / observed exposures as a rough form-use ratio. For
link invitations compare clicks / observed exposures. These are page-load events, not unique people
or a linked cohort: reloads, multiple placements on one visit, browser support and counter caps affect
them. Do not describe either ratio as a confirmed-subscriber conversion rate. Absent exposure data
means unknown, not zero. Dates are UTC; compare complete days or label a partial day explicitly.

## Weekly confirmed-subscriber check

1. In Buttondown's subscriber list, select the active/confirmed status rather than all addresses.
   Record only its aggregate count and the check's date/time. Do not export or copy addresses into
   this repository or the analytics dashboard.
2. Subtract the number of known owner/test accounts still active at that moment. Do not subtract an
   already-unsubscribed test account again. Record the resulting non-test active total.
3. Separately record pending confirmations, unsubscribes and failed deliveries as aggregate counts
   where available. Do not treat pending confirmations as growth or resend messages to them here.
4. Compare the adjusted active total with the previous adjusted total for **net subscriber growth**.
   That difference is not the number of new signups if anyone unsubscribed in between. Establish the
   first baseline from a fresh provider check; the launch's owner tests are not student proof.
5. Review the invitation and submission totals for the same complete UTC days. If many people submit
   but few become active, inspect the confirmation journey and message clarity; do not disable
   double opt-in or add email open/click tracking.

Copy this blank scorecard into the private analytics page or owner notes and fill it with real checks:

| Checked at (UTC) | Period (UTC) | Active confirmed | Active owner/test | Active non-test | Net change | Pending | Unsubscribes in period | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| | | | | | | | | |

Keep confirmed counts manual for now: the existing Buttondown key has email/sending access, not
subscriber access. No automated confirmation feed, visitor identity matching or cohort attribution
has been implemented. Do not broaden key permissions or buy a plan just to fill this scorecard.
Local copies, automated browsers and the owner's `?nocount=1` browser remain excluded from site
counts. Keep owner QA counting disabled and avoid creating real subscriptions just to test counters.
