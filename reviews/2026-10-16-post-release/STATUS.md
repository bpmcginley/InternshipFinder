# October 20 integration checkpoint

Integrated with main `0c70655d` in PR #124. Employer checkout and the current terms version
(2026-10-20), six Stripe webhook events, EMAIL binding and EMPLOYER_CHECKOUT=1 remain intact.
PRs #119, #131, #132 and #133 have merged; paid-listing launch is no longer a pending gate.
Manual listing activation/update stays refused while checkout is enabled; pilots use site checkout
with an allocated pilot code. Draft/pause/end/refuse remain available. No new launch action is needed.

The October 19 Monday digest was delivered by the catch-up path at 18:04 UTC; the later scheduled
run was stopped by the existing six-day duplicate guard. Do not resend to validate this branch.

The dashboard preview keeps the latest main data, reduced to 12 rows. The widget independently
uses its bounded full-field feed; both widget and employer role-index generation remain present.
The carryover merge preserves both stable-ID deduplication and completed-board closure evidence.

## Integrated validation and remaining gates

October 20 integrated suites passed: **315 extension, 214 site, 265 Worker and 1,108 backend**;
two optional backend checks skipped. Five real local Workers/D1 tests and two offline packaging tests
passed. The six public-media tests are now imported by the Worker directory runner, so normal CI
actually executes them. No real payment, application submission, social post or email was sent.

Exact-package real Google/personal-Microsoft sign-in and ordinary update preservation remain release
gates. Root is handling browser verification, merge/deployment and any separate publication decision.
Deploy the Worker media route before the changed scheduled social workflow next runs; do not force a post.
The existing employer config, orders, payment code, clickwrap text and terms page are identical to main.

`npm audit` reports six high-severity paths in existing dev-only Wrangler/Miniflare tooling; these are
not runtime imports deployed in the Worker. Plan a separately tested tooling update (audit suggests
Wrangler 4.151.2 and Cloudflare Vitest plugin 1.4.5), rather than an unreviewed launch-time upgrade.

## Historical October 16 checkpoint

Prepared on `codex/post-release-ready`, based on main `cbfef617`. These changes are reviewable source
and a local 0.5.8 candidate, not a deployment or store publication. No new social posts, outreach,
subscriber broadcasts, permissions or billing changes were made.

## Implemented and checked

- Extension 0.5.8 candidate carries the existing PR #118 fixes missing from the public 0.5.7 package
  and enables the optional weekly email completion link. Both ZIP variants build reproducibly with
  a source/hash record; release retries refuse different assets under one version. PR CI now checks it.
- Nine synthetic Lever/Ashby regressions cover prefill, protected facts, file destinations,
  cancellation, replaced controls and final-submit blocking. No production ATS change was necessary.
- Email refuses stale or invalid export timestamps before contacting Buttondown. Weekly health
  distinguishes scheduled broadcasts, manual tests, skipped sends and first-send timing. It never retries.
- Instagram Login Reels use a hosted MP4 through a bounded, fixed-source Worker route. Card fallback
  is explicit. An ambiguous final publish stops as unknown; it cannot trigger a duplicate fallback.
- Fresh listing IDs take precedence over stale carryover copies. The current export has 217 such
  collisions; the next normal ingest/export applies the correction. Separate conflicting canonical-URL
  copies and eligibility gaps remain documented, not silently merged or claimed fixed.
- The first-results preview is 12 rows instead of 60: estimated gzip 9,883 to 2,362 bytes (76.1% less).
  Full state loading remains. Font preload priority is lowered; no measured live latency claim is made.
- Support instructions have a troubleshooting anchor and private feedback route. Operating handoffs,
  publishing ownership, subscriber baseline and a consented five-student usability kit are reconciled.

## Validation

Consolidated local suites: **315 extension, 166 site, 199 Worker and 840 backend tests passed**;
two optional backend environment/media checks skipped. Two packaging/release tests passed, including
five simulated publisher scenarios. Independent source reviews covered release/primer boundaries,
weekly email timing and the public video route; their ambiguous-publish finding was corrected and tested.

Browser QA at 1280px and 390px checked full result loading, search beyond the initial preview,
unique email form labels and support navigation with no horizontal overflow. Search found two current
Wikimedia records, including a pre-existing conflicting URL copy; this confirms remaining data cleanup,
not successful deduplication of the current shards. No browser errors were observed. Screenshots are
kept outside the repo in the owner's product-review evidence folder. No controlled slow-network run,
real sign-in, installed-candidate update or real employer submission was performed.

## Resume in this order

1. Review/merge the consolidated PR. Deploy the Worker video route **before** the changed publishing
   workflow next runs. Pages and metrics changes follow the normal existing workflows; do not force a post.
2. Confirm the next normal ingest/export removes the stable-ID carryover collisions. Recheck remaining
   URL/eligibility samples from `listing-quality.md`; inaccessible pages remain unknown.
3. Complete the exact-package Google/personal-Microsoft sign-in, setup and ordinary-update checks in
   `../releases/extension-0.5.8.md`. Then submit the recorded Web Store ZIP and publish its matching
   developer release. Update the store support URL after `/install#troubleshooting` is live.
4. Observe the next normal weekly digest and weekly health; October 19 delivery is complete.
   Inspect provider status before any recovery; do not retry an already delivered broadcast.
5. Security headers need host/proxy/TLS inspection before applying the staged rule. Do not change DNS
   or enable proxying merely to apply it. Controlled cold-load timing and consenting student sessions remain.

Heycatch account checks showed six connected brand accounts and an existing YouTube/TikTok/Facebook
video queue. Preserve it; native YouTube must remain disabled. Threads is absent, and X/Reddit text
queues remain unverified. The private analytics page already separates form submissions from subscribers.
PR #119 and the later employer checkout launch (#132) are merged. Their production settings and
manual-activation restriction must be preserved by this integration.
