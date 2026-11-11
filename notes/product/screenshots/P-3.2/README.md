# P-3.2 review prompt evidence

**needs-bruce:** extension merge and release, including the single proactive side-panel surface. No release, manifest version or permission change is included. The package is based on main `45ad4c6d`; frozen production and focused-test commit: `f9574db6`.

## Policy and storage

The side panel offers one review card after the third successful fill, waiting until no application is working. Not now consumes this opportunity; there is no tenth-fill reminder. An unanswered card remains the same pending opportunity across panel reopening and temporarily waits behind working jobs. Passive Leave a review controls in the popup and panel remain available. The extension's dashboard `review_line` response is now false, preventing a second independently timed proactive suggestion. No website source changes.

The existing `review_ask` local key and its filled count, bounded deduplication IDs, asks and permanent done decisions remain. Version 2 migration consumes the opportunity when a legacy ask, open card or permanent decision exists. Legacy users already at three fills without an ask do not get a late prompt. Users below three without an earlier ask remain eligible. Reads normalize legacy records; the background persists version 2 on its next existing review write. No additional key, identity, profile data or telemetry is introduced. Retention and deletion behavior remain unchanged: this is extension-local state, removed with extension data.

New success evidence is an observed transition into Ready to submit. Manually marking Submitted is not evidence of filling. When the review key is absent, only existing Ready jobs seed its initial count; Submitted-only history cannot prove success. Already-stored legacy counts are preserved. Repeated Ready and Ready-to-Submitted transitions do not recount a job.

## Race and focus verification

An asynchronous queue render can read idle jobs, wait for review/storage dependencies, then finish after a job starts working. Queue/review changes now invalidate those renders. Immediately observing a working queue removes an existing card even while answer typing defers the full redraw. Focus inside the removed card moves to the Queue tab; focus outside it is preserved.

A focused regression exposed another ordering gap: reading the final queue in parallel with a delayed review read still allowed a stale idle snapshot to win. The final queue read now follows the review read; a generation check then guards the synchronous DOM commit. Tests cover both storage-event invalidation and a working queue discovered before its storage event arrives. These are synthetic queue/status tests, not actual employer or model runs.

## Screenshots

Real isolated headless Edge at 1280x1000 and 375x1000, both supported light/dark themes. Each phase captures second fill, third fill, working, dismissed and restarted: 40 PNGs total. Before serves review/panel source from `45ad4c6d`; after serves frozen package source. Same synthetic queue and local mock storage; requests are fulfilled exclusively from local repository assets. No real extension, account, resume, AI, employer posting, review tab or submission is used.

| Width/theme | Before second fill | After second fill | After third fill | Working | Dismissed | Restarted |
|---|---|---|---|---|---|---|
| 1280 light | [Before](before-1280-light-second-fill.png) | [After](after-1280-light-second-fill.png) | [Third](after-1280-light-third-fill.png) | [Working](after-1280-light-working.png) | [Dismissed](after-1280-light-dismissed.png) | [Restart](after-1280-light-restart.png) |
| 1280 dark | [Before](before-1280-dark-second-fill.png) | [After](after-1280-dark-second-fill.png) | [Third](after-1280-dark-third-fill.png) | [Working](after-1280-dark-working.png) | [Dismissed](after-1280-dark-dismissed.png) | [Restart](after-1280-dark-restart.png) |
| 375 light | [Before](before-375-light-second-fill.png) | [After](after-375-light-second-fill.png) | [Third](after-375-light-third-fill.png) | [Working](after-375-light-working.png) | [Dismissed](after-375-light-dismissed.png) | [Restart](after-375-light-restart.png) |
| 375 dark | [Before](before-375-dark-second-fill.png) | [After](after-375-dark-second-fill.png) | [Third](after-375-dark-third-fill.png) | [Working](after-375-dark-working.png) | [Dismissed](after-375-dark-dismissed.png) | [Restart](after-375-dark-restart.png) |

The third-fill wait checks the actual displayed count is three in both phases, rather than capturing the preceding two-fill card during its throttled redraw. Working screenshots wait for the Working status chip; immediate card removal and focus are checked earlier. All eight phase/size/theme workflows assert no horizontal overflow, no page errors, no remote requests, persistent dismissal after reload and the retained passive review control.

Reproduce with `CAPTURE_TOOLS` pointing to isolated tooling containing `playwright-core`, then `node notes/product/screenshots/P-3.2/capture.cjs before` or `after`. The script launches installed Edge using fresh contexts and never accesses the user's browser profile.

## Copy and checks

No new visible strings. Existing card title remains `Auto-Apply has filled {n} applications for you.` (now first offered at three), and all review, feedback, dismissal, job and passive-link text is unchanged. The old dashboard suggestion is no longer proactively displayed for the updated extension.

Final Node 22.23.4 extension suite: 348 passed, zero skips. Sixteen focused policy/panel tests cover migration, concurrency, restart, counts, manual-submission exclusion, the real background call boundary, dashboard suppression, delayed rendering, typing and focus. Packaging checks pass 2/2. Targeted ESLint and pinned Prettier checks pass. Golden source/archive/manifest files are unchanged; no refresh was run during the coordinated cache window. CI and independent final review are recorded on PR #212.
