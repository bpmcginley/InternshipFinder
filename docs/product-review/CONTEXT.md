# Product review handoff — 2026-10-13

## User objective
Review InternScout as a usable product: visuals, onboarding, feature quality, speed, accessibility, data quality, and reliability. Exclude outreach, marketing, SEO, pricing, and monetization. Coordinate independent reviewers and Gemini 4 Argon.

## Model setup and decision
- Antigravity CLI 1.3.4 installed at `%LOCALAPPDATA%/agy/bin/agy.exe`; installer added its directory to the user PATH (existing terminals may need restart).
- CLI authenticated with the user's Google AI Pro account. Its observed model list contained Gemini 3.8 Flash and other models, but no Argon 4.
- Gemini app was inspected and explicitly offered **4 Argon**, including **High** reasoning.
- Google AI Pro app access and Antigravity/API entitlements differ. The user declined separately billed API usage and chose existing Pro app access.
- Codex's provider/model configuration remains unchanged. No Gemini API key was requested after that decision, stored, or used; no API inference calls or billing changes were made.
- Gemini app assistance is coordinated through browser interactions, not an API bridge or a hot-swapped Codex model.

## Review source and evidence
An isolated snapshot of `origin/main` at commit `eeb41b4d` was created outside this checkout at `C:/Users/bruce/Documents/InternScout-ProductReview/source`.
The snapshot contains public tracked product code, public listing data, relevant tests, and evaluation fixtures. It excludes local credentials, personal profiles, untracked social setup artifacts, and the outreach/growth directory.
`C:/Users/bruce/Documents/InternScout-ProductReview/product-source.txt` contains numbered source for Gemini app review. Evidence and consolidated reports live in that external review directory. Refresh the snapshot before a future review of newer code.

## Completed independent review
Three Codex reviewers examined extension reliability, dashboard speed/data correctness, and accessibility/onboarding. Existing extension tests passed 162 cases and dashboard core tests passed 9 cases. Additional controlled offline reproductions identified gaps despite those passes. Source review is not equivalent to full browser/end-to-end coverage.

Priorities to independently validate before implementation:
1. Pause/Take over can allow a delayed AI response to perform page actions and overwrite paused status (`extension/background/agent.js`).
2. Decorated submit labels such as “Apply now →” can bypass the final-submit guard (`extension/agent/guard.js`). No real submission was attempted.
3. Fresh profiles default unknown eligibility to authorization Yes, sponsorship No, and age 18+; optional Quick facts allow those to become automatic answers.
4. Concurrent whole-store writes can erase saved logins or learned answers (`extension/lib/store.js`).
5. Resume replacement can retain old contact details and removed experience/projects.
6. Description-download requests can resolve before an existing download completes; failures remain silently cached for the session (`docs/js/core.js`).
7. A stalled listing shard can block all visible results; initial index-load errors have no in-product retry.
8. Batch selection can silently discard applications beyond 100 and update statuses for jobs not enqueued.
9. Text search for remote and the Remote dropdown use different predicates; salary placeholders appear as disclosed pay.
10. Custom pickers lack complete combobox semantics and onboarding does not reliably move focus between steps.

## Completed implementation and validation
Gemini Argon 4 High completed independent source and screenshot reviews using the existing Pro app allowance. Its response and screenshots are saved in the external review directory; conversation: https://gemini.google.com/app/0b4d643bd8b79f01 . No Gemini API calls were made.

Product fixes are implemented in the managed worktree `C:/Users/bruce/.codex/worktrees/product-quality/InternshipFinder` on `codex/product-quality`, based on merged main `9190a37d`. The earlier independent implementation is preserved on `codex/product-quality-wip` at `e2096c14`; do not apply it wholesale over Claude's changes.

Claude independently merged PR #93 while this branch was in progress. Review details are in `CLAUDE_REVIEW.md`. Its unmodified 179 tests pass, but two additional offline cases exposed takeover-before-prefill and unfamiliar-submit-on-review gaps. Both are fixed here while retaining Claude's multi-page guard, versioned injected scripts, temporary click block, focus restoration, generation checks, and Web Lock name.

Implemented product changes:
- Extension: cancellation checks after asynchronous preparation and immediately before page mutations; abortable retry waits; pending credentials reserved under the store lock and confirmed only on explicit same-host success.
- Profiles: unknown factual eligibility defaults; manual confirmation required before protected answers are available to prefill or the model; AI interview suggestions cannot count as manual confirmation. Resume imports replace previously extracted sections, preserve conflicts for review, and block activation until reading/review is complete. Changed-field saves preserve concurrent background edits.
- Privacy: demographic provenance is filtered from profile sync both in the client and before server encryption. Local answers remain intact.
- Dashboard: bounded downloads, progressively visible shards, retryable description failures, accurate batch confirmation and selection limits, consistent remote filtering, salary-placeholder filtering, combobox semantics, step focus, and mobile result controls.
- Listing quality: combined undergraduate/master's degree titles, multiple eligible class years, season/year URL overrides, Canada/remote suffix handling, and cleanup of ATS location prefixes before region classification.

Validation: extension 218 passed; dashboard 62 passed; Worker 166 passed; backend 619 passed, 2 optional media/environment checks skipped. All AI and employer-action regressions use synthetic offline fixtures. Browser checks covered the local dashboard at desktop and 390x844 mobile sizes: onboarding step focus, pickers, filtering, result cards, keyboard status control, no horizontal overflow, and no observed browser errors. Screenshots are in the external review directory's `evidence/` folder. This is not a real-employer dry run or a released extension.

Remaining: obtain PR/CI review and release authorization. Before release, use offline Workday/Greenhouse/iCIMS fixtures to check legitimate unknown-label navigation and human final submission; validate resume replacement in an installed extension. Gemini's additional source concerns about the legacy FastAPI path, ranking limits, and ingest history are not verified findings and are not claimed fixed. Do not merge/deploy or submit real applications as part of this review.

Codex configuration is unchanged. An unused, incomplete proxy environment remains inactive outside the repository because automatic approval review rejected its cleanup; do not work around that rejection.
