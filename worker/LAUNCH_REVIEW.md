# Employer checkout launch review

Reviewed October 19–20, 2026, including PR #132's approved legal round 4 (`5a26b9f0`) and latest main
through PR #131. The user authorized merge, configuration, webhook updates, deployment and five
unassigned pilot codes. This records technical checks; live deployment receipts remain owner notes.

## Findings corrected before activation

| Finding | Reproduction / impact | Correction and evidence |
|---|---|---|
| Concurrent checkout confirmations exceeded the field cap | Four occupied slots plus two simultaneous confirmations both returned payment URLs | Atomic field/listing/day reservations with database aborts and rollback; shifted approval dates are reserved again |
| Competing approval/refusal and uncertain provider responses | Opposite decisions could refund while placements activated; a lost refund response could allow a different credit choice | Immutable decision/credit claims precede effects. Running/unknown outcomes freeze for owner reconciliation; no blind financial retry |
| Early closure could lose compensation or overallocate cents | Failure between ending a role and inserting its credit lost the offer; three rounded shares could exceed a bundle's total | Closure and credit creation share one transaction; remainder cents allocated once |
| Failed or premature decision emails | Failed approval mail still claimed delivery and was not retried; mail could precede the committed decision | Durable outbox, committed-state eligibility and truthful response copy; daily retry and seven-year cleanup |
| Acceptance provenance and availability disagreed with UI | Explicit stale terms version accepted; each of three roles separately fit while their bundle did not | Required current version plus stored checkbox words; bundle-aware availability and client recovery |
| Credit deadline predated a delayed offer | Thirty-day timer used creation even when the offer email had never sent | Deadline/defaulting start from successful offer notification; uncertain choice UI directs safe status recovery |
| Manual placements bypassed the new cap | Legacy activation/update did not share reservations | Existing manual placements are included atomically. Direct manual activation/update returns 409 while checkout is enabled; reads, drafts, pause/end/refuse and reserved order review remain |
| Privacy summary omitted employer orders | Broad storage exceptions and a buy-page link contradicted the new records | Accurate exceptions/link plus a safe manual contact-removal runbook that also handles pending email and tokens |

Independent review found the pilot-code reservation leak, precommit mail and round-4 interactions;
these were corrected before the consolidated checks. Synthetic tests never charged a card or
submitted a real employer order. A lost provider response is deliberately not called a failed payout.

## Consolidated validation

- Node suites: **259 Worker tests** and **209 site tests** passed.
- Local Cloudflare Workers runtime: **5 tests** passed, including actual local D1 trigger enforcement,
  duplicate-listing reservation rejection, expired holds, and whole-batch rollback after a sixth slot.
  Wrangler's own SQL parser replaces a broken semicolon split in the smoke-test harness.
- PR CI also runs the pinned local Workers runtime tests now. No remote D1 or email binding is used
  by those tests. Production had no employer-order or pilot tables before this additive schema launch.
- Cloudflare showed the existing Paid plan, `internscout.org` enabled/configured for Email Sending,
  and the new review-inbox secret present. One owner-only diagnostic arrived in the owner's Gmail.
- Stripe's existing Billing endpoint retains its destination, API version and prior events; its saved
  six-event list includes delayed-payment success and dispute creation. No signing secret was changed.
- PR #131 is already merged; the live `/data/ingest-report.json` returned 404. Diagnostic artifacts
  remain run artifacts, not a private-data vault: the GitHub repository itself is public.

## Launch and operation boundaries

Wait for the final PR checks, merge, publish the matching `terms-2026-10-20` tag, and let Pages build
the role index before deploying the enabled Worker. Preserve the existing plain variables and secrets.
Verify public config, buy-page role loading and schema after deployment, without making a live charge.
Allocate the five private pilot codes one per first employer buyer; they are not automatically applied.

Uncertain financial operations need owner reconciliation. Alerts and unsent mail use the existing daily
cron; there is no new fifteen-minute scheduler or exactly-once email guarantee. Contact removal follows
`ORDER_CONTACT_REMOVAL.md`; no new public erasure route was invented. Do not erase payment history or
reset a financial claim to get past an error. The manual activation restriction is intentional.

The separate PR #130 widget false-empty-field defect is repaired in PR #133, independently of this
checkout launch. Earlier PR #124 remains a separate unreleased extension/product candidate; this work
does not publish extension 0.5.8 or merge that older branch.
