# InternScout product status

Updated: 2026-11-10. Owner: product lead. Instructions: [HANDOFF.md](HANDOFF.md) and [refactor coordination](../refactor/HANDOFF.md).

## Current position

- Product hand-off read in full from `origin/product/handoff-docs`; [PR #170](https://github.com/bpmcginley/InternshipFinder/pull/170) merged as `b8e08d1f` after independent review and all checks passed. Refactor hand-off and status read in full. Its [Pages run passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42864401492).
- Initial read-only audits cover site, worker, extension, growth, generated pages, and every product hand-off verification item. Evidence below distinguishes source findings from executed checks and account settings that cannot be inferred from source.
- Original checkout has unrelated uncommitted work and remains untouched. Each implementation package uses its own worktree, branch, PR, and independent reviewer.
- Before each package: fetch origin, reread refactor status, and list open PRs. Refactor structure has right of way. Stop new PRs for its announced formatting window. Never force-push, rewrite history, deploy the worker, release the extension, send outreach, or submit applications. Preserve MuseWork.md and others' work.
- No private business metrics, service identifiers, credentials, or personal profile data belong in this public tracker.
- PR #165 owns `growth/every_major_list.py`; queue that part of P-1.7. Refactor WP-0.1 has merged as `9f739770`; its Pages run succeeded. The refactor status still describes its review, so inspect current PRs as well as the tracker.

## Package tracker

Queued means not started, not approved for release. A dash means no branch or PR has been created. Split parts of a package get separate rows and PRs when ownership or approval differs.

| Wave | Package | Owner | Branch | PR | State | Next step / Bruce gate |
|---|---|---|---|---|---|---|
| 0 | P-0.1 Tracker | product lead | `codex/product-p0.1-tracker` | [#173](https://github.com/bpmcginley/InternshipFinder/pull/173) | Merged | `3eb55beb`; independent review and green CI; Pages pending verification. |
| 0 | P-0.2 Counter names | audit_worker_extension | `codex/product-p0.2-counters` | [#175](https://github.com/bpmcginley/InternshipFinder/pull/175) | In review; needs-bruce | All 16 names and bounded-total tests; local worker suites pass. Independent review/CI, privacy approval, worker merge and deploy remain. |
| A | P-1.1 Company runs | Unassigned | - | - | Queued | First app.js package; draft claim, screenshots, tests. |
| A | P-1.2 First screen | Unassigned | - | - | Queued | After P-1.1; plan-text edits require Bruce. |
| A | P-1.3 Rows | Unassigned | - | - | Queued | After P-1.2; display-only data changes. |
| A | P-1.4 Save and My list | Unassigned | - | - | Queued | After P-1.3; preserve existing statuses and return prompt. |
| A | P-1.7 Non-generated distribution | Unassigned | - | - | Queued | Split app/install ownership; README portion waits for #165; email text needs Bruce. |
| A | P-1.10 Flyer page | Unassigned | - | - | Queued | Browser-local QR; no third-party requests. |
| A | P-1.11 Install and offer | Unassigned | - | - | Queued | Preserve permissions explanation; demo clip from Bruce. |
| A | P-2.1 Follow design | Unassigned | - | - | Queued | Note first; needs-bruce before implementation. |
| A | P-2.2 Top-up design | Unassigned | - | - | Queued | Note first; needs-bruce before implementation. |
| B | P-1.5a Dashboard phone layout | Unassigned | - | - | Queued | Respect app.js and design-token ownership. |
| B | P-1.5b Generated phone layout | Unassigned | - | - | Queued | Only before WP-3.1 or after WP-3.5; update golden if available. |
| B | P-1.6 Checked-open evidence | audit_growth_generated | - | - | Skipped as written | last_seen proves observation, not a direct application-link check. |
| B | P-1.8 Out-of-runs arrival | Unassigned | - | - | Queued | Plan text needs Bruce; top-up stays absent until supported. |
| C | P-1.9 Employer entry | Unassigned | - | - | Queued | Generated-page hot-file rule. |
| C | P-1.7 Generated distribution | Unassigned | - | - | Queued | Generated-page hot-file rule. |
| C | P-2.3 Employer click design | Unassigned | - | - | Queued | needs-bruce: design approval before new counting. |
| D | P-2.1 Follow build | Unassigned | - | - | Waiting for design | No build before approved note; worker deployment stays with Bruce. |
| D | P-2.2 Top-up build | Unassigned | - | - | Waiting for design | No build before approved price, note, terms and secret setup. |
| D | P-3.1 Limit card | Unassigned | - | - | Queued | needs-bruce: extension merge and release. |
| D | P-3.2 Review ask | Unassigned | - | - | Queued | Verify existing trigger; needs-bruce: extension merge and release. |
| E | P-2.4 Cross-device list | Unassigned | - | - | Waiting for observation | P-1.4 live for two weeks, approved design/privacy, then build. |
| E | P-3.3 Resume first | Unassigned | - | - | Waiting for refactor | After WP-5.2; needs-bruce. |
| E | P-3.4 Practice form | Unassigned | - | - | Verification | Stop if a new host permission is needed; needs-bruce for extension. |
| E | P-4.1 Search landing pages | Unassigned | - | - | Queued | After matching refactor; capped pages, real listings, four-week observation. |
| E | P-4.2 Dated fact line | Unassigned | - | - | Queued | Real counts only; generated-page hot-file rule. |
| E | P-4.3 Share cards | Unassigned | - | - | Queued | Matching pages, build-time images, build cost check. |
| E | P-4.4 Advisor edition | Unassigned | - | - | Queued | Subscription/email work needs Bruce; no outreach. |

## Verified findings

Evidence references use `9f739770` unless noted. Source findings are not claims about production settings or observed browser behavior.

| Hand-off verification | Finding | Evidence / consequence |
|---|---|---|
| P-0.2 Unknown events before deployment | Verified by in-memory client and worker probes: group_expand sends once; beacon false/throw does not interrupt UI; worker returns counted:false without DB reads or writes. | `count.js:41-43,88-95`, `core.js:1002`, `visits.js:258`. No network or production request. Unknown events do not become page views. |
| P-0.2 Privacy coverage | Policy explicitly lists individual counted steps and does not name all new events. | `docs/privacy.html:241`; proposed policy wording must go to Bruce. Do not assume existing wording covers expansion. |
| P-1.2 Major typeahead | Existing shared keyboard combobox; profile currently commits only on explicit Setup Save. | `app.js:134-182,635,738,1188`. Quick set needs immediate persistence/reranking while preserving fields and loading failures. |
| P-1.6 Per-listing checked time | JSON inspection confirms per-row last_seen and older carried timestamps, but no explicit direct check timestamp. | `export_static.py:693-696` stamps current database rows with export time; `:504-506,550-562` preserves carried observations; `:233,573-615` includes search-derived rows. Skip the exact Checked open claim. Six-hour ingest schedule (`ingest.yml:5-6`) is not proof every posting is checked. |
| P-1.7 Widget field parameter | Already supported: friendly aliases and comma-separated OR tags. | `docs/widget/index.html:53-78,175-182`; README `:16-24`. Existing widget is the embedded viewer, not a snippet builder. Preserve iframe URL behavior; use a separate builder or explicit builder mode. |
| P-1.8 Upgrade arrival | Confirmed existing extension destination has upgrade query. | `extension/sidepanel/sidepanel.js:136`; no extension edit needed for site arrival. |
| P-1.9 Employer offer placement | Employer entry exists and is included on employer pages. | `seo_pages.py:1992-2003,3660`. Prefill is `/employers/buy/?company=<public key>`, not the general employer page (`buy.js:69-76,362`). Preserve actual destination. Existing price text remains Bruce-owned. |
| P-2.1 Sender rules and daily limits | mail.js requires EMAIL.send and ORDER_FROM; the binding and sender allowlist are configured despite its stale introductory comment. Actual deployment, onboarded domain, plan and account-specific quota remain unverified. | `mail.js:11,24-28`, `wrangler.toml:30-32,104`. Official [limits](https://developers.cloudflare.com/email-service/platform/limits/) and [bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) require eligible sending configuration; arbitrary recipients require Workers Paid. No universal daily number. Bruce verifies actual quota and reserves capacity for existing order mail before volume is chosen. |
| P-2.2 Referral bonus balance | Existing non-expiring pooled granted/used balance is reusable after design approval; it cannot identify unused units from one purchase. | `schema.sql:235-243`, `referral.js:37-40,114-126`, `limits.js:294-302,421,433`. Billing receipts are removed on processing failure and expire after 30 days (`billing.js:203-240`, `limits.js:577`): grant plus durable purchase identity must be atomic, with durable refund matching. |
| P-3.2 Review trigger | Executed local simulation: asks at fills 2 and 10; no prompt during working jobs. Counts ready_to_submit and submitted, deduplicates jobs. | `review.js:23,28,42-59`, `background/index.js:394`, sidepanel `:85-86`. Third-fill once migration must preserve past dismissals/reviews; dashboard webLineOk at review.js:73 currently uses two. |
| P-3.4 Practice host permission | Existing optional all-URLs permission and internscout.org content-script match mean no new manifest host pattern is inherently necessary. | `manifest.json:40-42,50`, `hosts.js:49-60`, `background/agent.js:144-177,671-676`. Programmatic injection can still need an existing optional grant. Source-verified conditional path, not live browser proof; stop if implementation requires any new permission. [Chrome permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) and [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting) distinguish these permissions. |

Additional corrections: `growth/flyers.py:26,60-68` uses a fixed homepage QR URL, contrary to the hand-off's campus naming assumption. Existing worker flyer grammar is `flyer` followed optionally by a hyphen and 1-16 lowercase alphanumeric characters (`visits.js:92-96`). Add browser-side campus naming deliberately within that grammar. GitHub field links already exist (`every_major_list.py:183-185,259,274`); avoid duplicating them and respect PR #165 ownership. Digest footer changes affect both HTML (`digest.py:400-405`) and text (`:458-459`) and require Bruce. Generated tables have named, focusable scroll regions and semantic headers (`seo_pages.py:2388-2401`); preserve accessibility when adding narrow-screen layout. No browser layout reproduction is claimed by these source audits.

Site implementation constraints: `app.js:443-458,1364,1405` couples rendered rows, counts and selection; group collapsing must keep all three honest. `appstate.v1` maps listing IDs to status, while `saved.v1` stores saved searches (`app.js:839-840,1237,1263`), so do not repurpose saved.v1 for roles. Preserve the return prompt (`:1683-1701`) and closed-role rule (`core.js:477-480`). Navigation exists in static HTML and rendered app (`index.html:777`, `app.js:1798-1807`). Preserve offer focus, scroll-padding and dismissal behavior (`offer.js:106-150`) and install HowTo structured-data consistency.

Full-read inventory completed by three independent read-only agents: docs/index.html, app.js, core.js, offer.js, count.js, install.html, widget index and README; worker visits.js, limits.js, referral.js, billing.js, mail.js; all three sidepanel files and background/gemini.js; growth every_major_list.py, digest.py and flyers.py; page() and table() in seo_pages.py. Supplemental references were inspected for every verification above. Neither extension UI nor practice injection has been observed in Chrome yet. New counters are once per event per page load, not unique people or every repeated click. Top-plan cap handling needs a marker independent of upgrade offers (gemini.js and background/agent.js:914); do not modify protected guard files.

## Validation and publication ledger

No product implementation merged yet. Clean baseline `9f739770`: all 244 site tests passed, no skips; `python scripts/startup_budget.py` exited successfully. This script reports local payload estimates, not a browser timing measurement or an enforced threshold. Check every PR's current head, independent review, all CI checks, and required screenshots. Site-only Stage 1 merges are authorized; needs-bruce changes remain open. Pages runs on every main push; verify it before the next merge. Any failed publication requires a new revert PR.

## Waiting for Bruce

Dates are when the item was recorded, not a claim that a separate message was sent. Completion remains blank until verified.

| Recorded | Item | Ready artifact / next action | Done |
|---|---|---|---|
| 2026-11-10 | Pause paid Meta campaigns; decide whether to keep Zeely | Owner action; no campaign changes by this session. | - |
| 2026-11-10 | P-0.2 worker merge and deploy | [PR #175](https://github.com/bpmcginley/InternshipFinder/pull/175); independent review and green CI before Bruce merges. Deploy only after approved disclosure is published. | - |
| 2026-11-10 | P-0.2 privacy wording for new named events | [Exact proposed wording](P-0.2-counter-review.md) is unapproved; published policy remains unchanged. | - |
| 2026-11-10 | Approve every Stage 2 design note | Exact words, stored data, retention and deletion will be supplied before build. | - |
| 2026-11-10 | Top-up price, size, Stripe price and secret | P-2.2 design first; never put private identifiers in the repo. | - |
| 2026-11-10 | Postal address and follow-email wording | P-2.1 design first; account sending entitlement also needs verification. | - |
| 2026-11-10 | Rename/topic/share the public GitHub list | Coordinate with existing PR #165; owner action. | - |
| 2026-11-10 | Record or approve an Auto-Apply demo clip | P-1.11 leaves space without claiming a demo exists. | - |
| 2026-11-10 | Extension merges and release after Stage 3 | Link reviewed PRs as ready; no release by this session. | - |
| 2026-11-10 | Monthly tool costs for cost review | Provide privately; no business figures in this public repository. | - |

## Measurement follow-up

After each package has been live for 14 days, assess its named aggregate counter using owner-provided read-only evidence. Record qualitative findings here; keep private business numbers out of this public repository. Do not infer results before the observation period. No automated production query or scheduled task has been created.
