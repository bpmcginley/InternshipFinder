# October 16 implementation checkpoint

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
4. Observe the first scheduled October 19 12:00 UTC / 8 a.m. EDT digest, provider delivery and archive.
   Inspect provider status before any recovery; no catch-up broadcast is requested. See the email runbook.
5. Security headers need host/proxy/TLS inspection before applying the staged rule. Do not change DNS
   or enable proxying merely to apply it. Controlled cold-load timing and consenting student sessions remain.

Heycatch account checks showed six connected brand accounts and an existing YouTube/TikTok/Facebook
video queue. Preserve it; native YouTube must remain disabled. Threads is absent, and X/Reddit text
queues remain unverified. The private analytics page already separates form submissions from subscribers.
PR #119 remains intentionally gated to the first paid placement and is outside this checkpoint.
