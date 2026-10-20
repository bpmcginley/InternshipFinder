# InternScout execution plan

Started October 19, 2026 Eastern / October 20 UTC. Owner: Codex, with parallel release,
listing-quality and growth reviewers. The user authorized executing this plan. This is
an implementation task, not merely a product review.

## Outcomes and evidence

The October 19 growth report (#129) reports 990 visits, 640 to internship landing pages.
These are visits, not unique students. Employer checkout and the full-field widget are
live through PRs #132 and #133. PR #124 remains an unreleased product candidate.
No current confirmed-subscriber or returning-student count has yet been established.

| Priority | Work | Completion criterion | Owner / status |
| --- | --- | --- | --- |
| 1 | Reconcile PR #124 and release fixes | Current-main integration reviewed; relevant suites pass; safe Worker/site changes deployed; exact-package extension gates recorded before store submission | Release agent + Codex; in progress |
| 1 | Accurate homepage promise | Static and hydrated copy agree and avoid universal coverage claims; live deployment verified | Codex; in progress |
| 1 | Listing quality | Reproducible 40-role stratified sample; duplicate, location and eligibility results distinguish unknowns; evidenced safe fixes tested | Listing agent; in progress |
| 1 | Student journey | Browser checks on desktop/mobile; installed-package authentication/update checks where tools permit; five-person protocol and recording sheet ready | Codex + growth agent; pending |
| 2 | Conversion baseline | Existing anonymous exposure/click/submit metrics summarized; confirmed non-test subscribers checked separately; unknown counts explicitly marked | Growth agent + Codex; in progress |
| 2 | Two growth experiments | Career-center/widget and one well-covered major campaign have ready materials, tagged destinations, success/stop rules and recording sheet | Growth agent; in progress |
| 2 | Heycatch trial value | Actual renewal date/cost, account queues and failure status inspected if authenticated; preserve existing schedules and one publishing owner per channel | Codex; pending |
| 2 | Employer operational readiness | Existing synthetic approval/refusal/delayed-payment/refund coverage verified; recovery/backup procedure documented and nonproduction restore tested where possible | Codex; pending |
| 3 | Search quality | Inspect current evidence for representative high-value pages; identify actionable indexing issues without treating every unindexed page as a fault | Codex; pending access |

## Sequence

1. Work in clean, isolated worktrees. Preserve the primary checkout and other agents' changes.
2. Reconcile pending code while parallel agents audit listings and prepare experiments.
3. Review the combined changes, run meaningful checks, and deploy dependencies in order:
   Worker video route before the changed social workflow; site via the usual Pages workflow.
4. Verify public behavior and record exact versions, test outcomes and any remaining gates.
5. Complete live account checks and populate the scorecard with available aggregate evidence.
6. Hand over a seven-day run sheet and ready student/partner materials. Record work requiring
   real participants or inaccessible accounts as pending; do not claim it happened.

## Measurement and decisions

- Existing signup target: 25 confirmed non-test subscribers in the intended audience. A confirmed
  address alone is not evidence its owner is a student. Provider counts stay aggregate and private.
- Form exposures, clicks and submissions are page-load events, not unique people or confirmed
  conversion. Keep double opt-in and the existing no-email-open/click-tracking promises.
- Proposed usability target: five consenting students; observe relevant search, extension assistance
  without final application submission, and digest confirmation. Fix repeated blockers first.
- Growth experiments run for two complete weeks after distribution begins; agent-produced drafts
  alone do not start their measurement clock. Use existing measurement, not new identity tracking.
- Reassess features using observed failures, relevant application actions and consented repeat-use
  feedback. Do not infer retention from raw page views.

## Boundaries and dependencies

No outreach, new social posts, extra newsletter sends, purchases, paid AI tests, real employer
applications or live payment/refund tests are part of this execution. Draft materials and verify
existing queues; publication and participant recruitment need specific sending instructions.
No fabricated users/reviews, no new personal-account connections, no broadened provider permissions.
Keep the existing terms/version and employer pilot-code inventory. Pilots use site checkout;
manual activation/update remains blocked while self-serve buying is enabled.

Record execution evidence and remaining work in STATUS.md beside this plan. Do not store tokens,
private subscriber identities, codes or credentials in these documents.
