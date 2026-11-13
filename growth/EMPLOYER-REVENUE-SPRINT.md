# Employer paid listing sprint, October 23, 2026

## Goal and scope

Make the existing paid listing service easier to find, buy, evaluate and deliberately buy again.
Keep the existing prices, student protections, review process and financial safeguards. No outreach,
real orders, provider charges or customer mail are part of development or validation.

## Delivery plan

1. **Offer and discovery:** explain $29 per role for 30 days before the contact form, show an explicitly
   illustrative ad, retain the $69 bundle, $15/$35 public-body prices and existing first-five pilot.
   Add quiet Hire interns navigation and a company-specific role picker entry. Free additions and
   corrections stay visible. Checkout controls remain gated by the Worker's enabled response.
2. **Measure the funnel:** anonymous exposure/click and buy-page action totals, plus transactional
   server counts of created orders, verified email, positive payments, pilots, comped checkouts and
   repeat paying employers. Server transitions count once, including webhook retries. No visitor IDs,
   company names, emails, tokens or query strings go into analytics. Browser actions are not sales.
3. **Complete the service:** daily processing queues a report only after an eligible natural campaign
   end and the close of its final calendar month. A separate daily invocation processes up to three
   new and three due reports, leaving larger backlogs for following days. Report whole ended months using the existing
   privacy rule, round shown/open totals, explain repeats and missed bots and
   that applications are unknown. Retry provider failures with a durable lease and remove queued
   contact details after sending or expiry. A link opens the normal company picker; it never renews,
   accepts terms or charges anyone. Conservative exclusions remain visible to the owner.
4. **Operate and learn:** read the aggregate report with `cd worker; node scripts/placement.mjs metrics`.
   Inspect failed/skipped report counts and existing order/placement logs. Review the last 28 complete
   UTC days weekly after release. New funnel events start at deployment; do not treat prior missing
   events as zero customer activity.

## Success measures and next decisions

- Track offer views, entry clicks, form intent, created orders, verified orders and positive payments
  separately. These are action counts, not unique people or linked-person conversion rates.
- Track paid versus pilot orders, repeat paying employer keys, collected cents and recorded refunds.
  Cash remaining after recorded refunds is not profit: subtract fees, disputes, outstanding credits,
  hosting and time spent on sales, review and support. Record those costs in the owner's private books.
- Use the existing first-five pilot process to test the service. Do not create fake demand, testimonials
  or guaranteed applicant claims. Pilot codes still go through the site and normal review.
- Reassess after three completed paid campaigns or four weeks, whichever comes later. If role selection
  or verification loses employers, fix that step before increasing traffic or adding new offers.
- Treat a second positive payment as evidence worth investigating, not proof that a role renewed or
  an employer hired. Reporting cannot attribute applications or hires.

## Release and rollback

Open a tested PR and leave launch to Bruce. Deploy schema before Worker code, then publish the site.
Existing orders are not backfilled into the new event history. The report processor conservatively
skips invalid counts, paused/manual-ended campaigns and disputed orders. `EMPLOYER_REPORTS=0` pauses
new report delivery; contact-data expiry still runs independently. Reports wait for the final
calendar month to end, and whole-month totals can use the existing monthly rollups.
Verify one synthetic completed campaign locally, not by sending to a real employer. After deployment,
read the authenticated aggregate report and verify the public offer and company prefill manually.

To roll back, revert the site and Worker hooks. Leave new tables and tombstones in place so a later
release cannot resend accepted mail. To stop server funnel counting too, remove the named
`employer_funnel_*` triggers; do not erase existing financial records or alter payment state.

## Deferred

Real outreach, paid ads, higher prices, institutional feeds, email sponsorship activation, automatic
renewal and new student paywalls are outside this sprint. Browser/provider delivery in production is
not proven by local tests. No earnings forecast substitutes for actual paid campaigns.

## Completed implementation and evidence

All four delivery steps are implemented for review. Independent reviewers checked the offer, safe
prefill, transactional metrics, report eligibility/retries, contact removal and dedicated cron budget.

Paired local builds used the same listing snapshot from main `ee3ad6a` and the same saved live
sitemap/noindex/content-date inputs:

| Check | Main baseline | Sprint |
| --- | ---: | ---: |
| Built HTML pages | 2,171 | 2,171 |
| Sitemap URLs | 1,215 | 1,215 |
| Company-specific purchase entries | 0 | 812 |
| Missing internal targets / directory redirects | 0 / 0 | 0 / 0 |

All 812 company-entry keys exist in the public role picker index. Sitemap membership and the noindex
inventory are unchanged. The sprint build resolves 201,267 internal references. Browser checks of the
local sales page covered desktop and 390x844 phone layout, visible unavailable-order fallback and the
free-help anchor; no horizontal overflow was observed. The enabled gate and order/prefill behavior
were tested with synthetic responses, without live orders or email. Browser control disconnected
after those layout checks; production provider delivery was not tested.

Final local validation: backend 1,230 passed / 2 skipped; site 228 passed; Worker 306 passed;
actual Workers/D1 runtime 8 passed. The largest report batch test uses 33 D1 calls plus three email
stubs; the isolated cron adds one expiry call, keeping the measured full path below 50 calls.
Full logs and paired build comparison are in the owner's local
`InternScout-Employer-Sprint-evidence-2026-10-23` folder. No production deployment, payment or
customer message has been performed as part of this sprint.
