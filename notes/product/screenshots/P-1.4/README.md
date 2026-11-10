# P-1.4 Save and My list evidence

This package is **needs-bruce** because it introduces browser-only membership and a prior-visit timestamp. It is stacked on frozen P-1.3 #193 (`9c5d14c1`), whose parent is #187. Do not merge into either parent. After the parents are accepted, retarget to main, integrate normally and repeat checks/review.

Real headless Edge captures use isolated contexts at 1280 × 1000 and 375 × 1000, light/dark, locale en-US and America/New_York, with the clock fixed to 2026-11-10 18:00 UTC. Before serves dashboard HTML/app.js from `9c5d14c1`; after serves this package. Both sides seed the same synthetic legacy statuses, named search, setup-skip preference and previous visit.

| Width/theme | Before | After Browse | After My list |
| --- | --- | --- | --- |
| 1280 light | [Before](before-1280-light.png) | [Browse](after-1280-light.png) | [My list](after-mylist-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [Browse](after-1280-dark.png) | [My list](after-mylist-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [Browse](after-375-light.png) | [My list](after-mylist-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [Browse](after-375-dark.png) | [My list](after-mylist-375-dark.png) |

Additional evidence: [failed current-data lookup with saved identity and retry](after-unavailable-375-dark.png). My list captures include all five migrated statuses, a known closed role and an absent historical ID with unknown current status.

## Fixture and reproduction

`capture.cjs` reuses the seven explicitly synthetic P-1.3 listings and adds synthetic closed and California roles. Employers contain `Fixture`; application links use `jobs.example.com`. The pagination case adds 151 synthetic roles. These are test data, not real opportunities or business metrics. No application link opens: return-prompt tests prevent navigation before invoking the existing click handler and visibility events.

Every request is fulfilled locally. The mocked extension responds through the existing postMessage bridge and records a synthetic enqueue payload without using an extension, employer, account, AI service or submission. Local React/ReactDOM 18.3.1 and playwright-core are isolated test dependencies, not site dependencies. No third-party request is added.

```powershell
$env:CAPTURE_TOOLS = 'C:\path\to\isolated-tools'
node notes/product/screenshots/P-1.4/capture.cjs before
node notes/product/screenshots/P-1.4/capture.cjs after
```

The tools directory contains `node_modules/playwright-core`, `react`, and `react-dom`. The script launches installed Edge in fresh contexts. `after --extra-only` repeats supplemental data-loading, storage, queue, timestamp and pagination checks without recapturing the four main workflows.

## Storage and deletion

- `internscout.appstate.v1` remains the existing ID-to-status map. Saving a role without a status initializes Interested; existing Applied, Interviewing, Rejected and Offer values are preserved. Unsaving never deletes history, and later queue/return-prompt status updates respect explicit unsaves.
- `internscout.saved.v1` remains named saved searches, including their filters. It is not used for saved role IDs.
- New `internscout.mylist.v1` contains `{version: 1, roles: {id: {saved, company, title, url, shards}}}`. Initial migration enrolls existing non-none statuses once. An explicit `saved: false` prevents remigration. Snapshots allow only public company/title, an untruncated HTTP(S) posting URL up to 2,000 characters, and validated public shard hints. No descriptions, pay, profile, resume, account or AI content is copied. Missing data stays outside the listing store; current role data wins when available.
- New `internscout.visit.v1` holds the current visit's timestamp for the next visit. The prior value is read once. A badge requires an open role with valid first_seen after that prior timestamp and no later than this visit. Naive ISO scan timestamps are UTC, matching the export; posted_at is never used for this badge.
- These local values remain until the user clears browser storage or explicitly deletes the browser tracker. My list has a confirmed deletion action even without a profile. The existing optional tracker-deletion confirmation after profile deletion also clears both new stores. Cancel preserves history, membership, saved searches and the visit marker. Profile/account deletion behavior is otherwise unchanged. Blocked storage works in memory for the tab and displays a truthful persistence message.

Only `save_role` on an explicit save and `mylist_open` on entering that view are sent through the existing aggregate counter helper, without IDs or properties. Recording still awaits P-0.2 disclosure/deployment; this PR performs neither.

## Measured checks

- The 270-test parent baseline passes. Fifteen new tests cover migration, unsave/reload, safe snapshots, missing versus closed roles, zero-request cached resolution, in-flight promises, progressive batches of at most four, cancellation, failures, visit semantics, canonical status-update composition, accessible controls and focus. Existing row focus/name tests cover the replacement Browse control and retained My list status select.
- Browser checks exercise keyboard Save, retained focus, migrated statuses, direct status changes, unsave and heading focus, preserved history after reload/resave, saved searches, Browse filters/URL, and return-prompt answers. Progress-filtered answers and status changes restore heading focus when a row disappears.
- Browse and My list maintain separate selections. A mocked enqueue proves an unsaved Browse selection cannot leak into My list; returning to Browse restores it. A queued ID clears in both views while unrelated selections remain. Missing snapshot rows cannot enter Auto-Apply.
- A cached save adds zero data requests. A delayed hinted shard resolves without broadening Browse. A failed shard keeps current status unknown and can be retried. Unknown legacy IDs use progressive public shards; cancelling the view stops future batches. No descriptions are fetched by the My list resolver.
- First visits and unchanged reloads have no new-since-visit badge. Naive UTC timestamps are checked in the New York browser timezone. Pagination checks 150 of 156 actually shown, then all 156 after Show more, including the live-region count.
- All four main viewport/theme combinations have no horizontal overflow or page errors. Deletion confirms and cancellation, and blocked storage, are exercised in the browser. Final full-suite, golden, lint, startup and CI/review results are recorded on the PR.

## New or changed visible strings

- `Browse roles`; `My list ({N})`; heading `My list`; `Save`; `Saved`; accessible toggle name `Save {title} at {company}`; Browse column heading `Save`.
- `My list progress`; existing `Any progress`, `Not started`, `Interested`, `Applied`, `Interviewing`, `Rejected`, `Offer` and status labels remain unchanged inside My list.
- `Saved roles stay in this browser.`; `Delete browser tracker`.
- `Delete your application statuses, saved roles, saved searches and last-visit timestamp from this browser? This cannot be undone.`
- `Also delete your application statuses, saved roles, saved searches and last-visit timestamp from this browser? Cancel keeps them.`
- `Browser storage is unavailable. Changes to My list last only in this tab.`
- `New since your last visit` replaces the old scan-window `New` row badge.
- `{shown} of {matching} saved role(s) shown`, with ` ({total} total)` when filtered, and ` · Checking current listing data…` while loading. The live region uses the same count plus `Checking current listing data.`
- `Checking current listing data. Saved information is shown.`; `Couldn't check current listing data. Saved information is shown.`; `Not in the current listing data. Current posting status unknown.`
- `Saved role {id}` and `Listing details unavailable` when no public identity snapshot exists; `Retry saved role details`.
- `No saved roles yet. Save a role to keep it here and track your progress.`; `No saved roles have this status.`

Known closed roles keep the existing `Closed` marker. Application statuses, return-prompt copy, salary text, plan wording and action labels are otherwise unchanged.
