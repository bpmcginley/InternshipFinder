# InternScout product status

Updated: 2026-11-10. Owner: product lead. Instructions: [HANDOFF.md](HANDOFF.md) and [refactor coordination](../refactor/HANDOFF.md).

## Current position

- **PR #188 publication incident:** Pages [run 42893547158](https://github.com/bpmcginley/InternshipFinder/actions/runs/42893547158) built successfully, then deployment failed with HTTP 400 because a preceding deployment remained in progress. PR #188 is not confirmed published. The recovery branch uses an ordinary `git revert -m 1` of merge `1fde9f42`; it preserves all other main merges. This is deployment recovery, not a product-code defect. Lead review, green checks, and an inactive preceding deployment are required before the lead merges the recovery PR.

- Product hand-off read in full from `origin/product/handoff-docs`; [PR #170](https://github.com/bpmcginley/InternshipFinder/pull/170) merged as `b8e08d1f` after independent review and all checks passed. Refactor hand-off and status read in full. Pages passed (run 42864401492).
- Initial read-only audits cover site, worker, extension, growth, generated pages, and every product hand-off verification item. Evidence below distinguishes source findings from executed checks and account settings that cannot be inferred from source.
- Original checkout has unrelated uncommitted work and remains untouched. Each implementation package uses its own worktree, branch, PR, and independent reviewer.
- Before each package: fetch origin, reread refactor status, and list open PRs. Refactor structure has right of way; coordinate source-file ownership around its mechanical formatting. Never force-push, rewrite history, deploy the worker, release the extension, send outreach, or submit applications. Preserve MuseWork.md and others' work.
- No private business metrics, service identifiers, credentials, or personal profile data belong in this public tracker.
- **Updated authorization (2026-11-10):** Bruce explicitly lifted the formatting notice-time and empty-queue requirements in the refactor chat; the product lead verified that instruction. This supersedes the earlier timing/queue hold and the instruction to leave PRs #165, #175, #177 and #178 open. It does not authorize worker deployment, extension release, or unspecified payment/email implementation choices.
- **Exclusive integration ownership:** the refactor lead owns review, integration and merge of #165, #175, #177 and #178. Product agents must not edit those branches or duplicate their integration work. Other needs-bruce decisions remain with Bruce; merging a design note does not select its unresolved build choices.
- **Near-term sequence:** record this documentation-only checkpoint now, let the imminent Python and JavaScript mechanical-formatting PRs land, then fetch and resume P-1.2 onward in hand-off order. Product Python/JavaScript edits wait for that file-coordination milestone, not a new approval or clock deadline. Refactor owns the formatting schedule; product retains one package/worktree/PR and independent review for each subsequent package.
- PR #165 still owns `growth/every_major_list.py`; its integration is now refactor-led. Queue the overlapping part of P-1.7 until that integration is complete. Inspect current PRs as well as the trackers, which may lag the explicit authorization above.

## Package tracker

Queued means not started, not approved for release. A dash means no branch or PR has been created. Split parts of a package get separate rows and PRs when ownership or approval differs.

| Wave | Package | Owner | Branch | PR | State | Next step / Bruce gate |
|---|---|---|---|---|---|---|
| 0 | P-0.1 Tracker | product lead | `codex/product-p0.1-tracker` | [#173](https://github.com/bpmcginley/InternshipFinder/pull/173) | Merged; Pages green | Independent review and all CI passed; Pages 42865303436. |
| 0 | P-0.2 Counter names | Refactor lead (integration) | `codex/product-p0.2-counters` | [#175](https://github.com/bpmcginley/InternshipFinder/pull/175) | Reviewed; refactor-owned merge | Refactor lead owns authorized integration/merge. Disclosure approval/publication and worker deployment remain separate gates. Unknown events remain harmless meanwhile. |
| A | P-1.1 Company runs | audit_site | `codex/product-p1.1-company-runs` | [#176](https://github.com/bpmcginley/InternshipFinder/pull/176) | Merged; Pages green | 251 site tests, two golden tests, eight screenshots and independent review passed; Pages 42867992902. Counter waits for P-0.2. |
| A | P-1.2 First screen | Unassigned | - | - | Queued | After P-1.1; plan-text edits require Bruce. |
| A | P-1.3 Rows | Unassigned | - | - | Queued | After P-1.2; display-only data changes. |
| A | P-1.4 Save and My list | Unassigned | - | - | Queued | After P-1.3; preserve existing statuses and return prompt. |
| A | P-1.7c Digest footer link | audit_worker_extension | `codex/product-p1.7c-digest-link` | [#202](https://github.com/bpmcginley/InternshipFinder/pull/202) | Prepared; needs-bruce | Exact HTML/plain-text footer copy: Internships for every major on GitHub. 102 digest/sender/footer tests, both golden tests (695 unchanged files), scoped Ruff and four synthetic screenshots passed. Email wording requires Bruce approval; no sending/provider/subscriber changes. |
| A | P-1.7 Remaining non-generated distribution | Unassigned | - | - | Queued | Split app/install ownership; README portion waits for #165; email text needs Bruce. |
| A | P-1.7b Install distribution links | audit_worker_extension (recovery) | `codex/revert-product-188` | [#188](https://github.com/bpmcginley/InternshipFinder/pull/188), [recovery #197](https://github.com/bpmcginley/InternshipFinder/pull/197) | Revert pending publication; implementation reviewed but not published | Merge 1fde9f42 failed Pages deployment in run 42893547158 after its build passed. Ordinary recovery revert restores pre-188 public and golden bytes; independent review and green CI required. Lead waits for the preceding Pages backend deployment to stop before merging recovery. No manual workflow or publication action. |
| A | P-1.7a Widget builder and feed guide | audit_growth_generated | `codex/product-p1.7-widget-guide` | [#182](https://github.com/bpmcginley/InternshipFinder/pull/182) | Merged; Pages green | Independent review; 258 site tests, 695-file golden match, publication audit and [24 screenshots](screenshots/P-1.7a/README.md). Existing embed unchanged. Merged as d42e7fce; Pages run 42872637139 passed. |
| A | P-1.10 Flyer page | product lead | `codex/product-p1.10-flyer` | [#181](https://github.com/bpmcginley/InternshipFinder/pull/181) | Merged; Pages green | Local QR, bounded campus tag, one-page print; independent review, 254 site tests and four browser/QR cases passed; Pages 42869656734 passed. |
| A | P-1.11 Install and offer | audit_worker_extension | `codex/product-p1.11-install-offer` | [#180](https://github.com/bpmcginley/InternshipFinder/pull/180) | Merged; Pages green | Independent review; 24 screenshots; 257 site tests, two golden tests (695 files), and both linters pass. Includes corrected install assertion in backend/tests/test_seo_pages.py; full backend passed 1,480 tests with two known optional-dependency skips. Merged as 2ba50743; Pages run 42876965306 passed. |
| A | P-2.1 Follow design | Refactor lead (integration) | `codex/product-p2.1-follow-design` | [#177](https://github.com/bpmcginley/InternshipFinder/pull/177) | Reviewed; refactor-owned merge | Refactor lead owns the design-note integration/merge. Unspecified email scope, retention and sending choices still need Bruce before build. |
| A | P-2.2 Top-up design | Refactor lead (integration) | `codex/product-p2.2-topup-design` | [#178](https://github.com/bpmcginley/InternshipFinder/pull/178) | Reviewed; refactor-owned merge | Independent design/existing webhook-path review complete; refactor lead owns the note integration/merge. Unspecified price, grant/refund/deletion and wording choices still need Bruce before build. |
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

Clean baseline `9f739770`: all 244 site tests passed, no skips; `python scripts/startup_budget.py` exited successfully. This script reports local payload estimates, not a browser timing measurement or an enforced threshold. Check every PR's current head, independent review, all CI checks, and required screenshots. Site-only Stage 1 merges are authorized. The refactor lead now exclusively owns authorized integration/merge of #165, #175, #177 and #178; other needs-bruce decisions remain gated as listed below. Pages runs on every main push; verify it before the next merge. Any failed publication requires a new revert PR.

| PR | Merge commit | Verification | Pages |
|---|---|---|---|
| #170 Hand-off | `b8e08d1f` | Independent review; all checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42864401492) |
| #173 Tracker | `3eb55beb` | Independent review; all checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42865303436) |
| #176 Company runs | `898e4327` | Independent review; 251 site tests, two golden tests, required screenshots; all checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42867992902) |
| #181 Flyer page | `ad180f0d` | Independent review; 254 site tests, browser/QR checks and required screenshots; all checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42869656734) |
| #182 Widget builder and feed guide | `d42e7fce` | Independent review; 258 site tests, 695-file golden match, required screenshots; all checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42872637139) |
| #180 Install and offer | `2ba50743` | Independent review; 257 site tests, two golden tests, 24 screenshots; all nine checks passed | [Passed](https://github.com/bpmcginley/InternshipFinder/actions/runs/42876965306) |

The golden harness now covers static assets as well as generated pages. Each site PR refreshes both manifest and archive from the integrated tree, identifies intentional path changes, and preserves other packages' outputs. New public paths also require exact site-allowlist entries. No generator page family has changed in the completed product work.

## Waiting for Bruce

- [P-1.7c / PR #202](https://github.com/bpmcginley/InternshipFinder/pull/202): approve the email footer link text `Internships for every major on GitHub`, pointing to `https://github.com/bpmcginley/internships-every-major`, in both HTML and plain text. PR remains needs-bruce and open; no email is sent.

Dates are when the item was recorded, not a claim that a separate message was sent. Completion remains blank until verified.

| Recorded | Item | Ready artifact / next action | Done |
|---|---|---|---|
| 2026-11-10 | Pause paid Meta campaigns; decide whether to keep Zeely | Owner action; no campaign changes by this session. | - |
| 2026-11-10 | P-0.2 worker deployment and disclosure | Refactor lead owns authorized merge of [reviewed PR #175](https://github.com/bpmcginley/InternshipFinder/pull/175). Approve/publish disclosure before deployment; no deployment by this product session. | - |
| 2026-11-10 | P-0.2 privacy wording for new named events | [Exact proposed wording](https://github.com/bpmcginley/InternshipFinder/blob/codex/product-p0.2-counters/notes/product/P-0.2-counter-review.md). No published policy changed. follow_confirm measures a browser confirmation-page signal. | - |
| 2026-11-10 | P-2.1 follow design and email wording | [Reviewed PR #177](https://github.com/bpmcginley/InternshipFinder/pull/177): approve field/state search scope, linked-account deletion behavior and daily email HMAC marker retention through next UTC midnight (at most 24 hours). The note merge is refactor-owned; unspecified implementation choices still require approval. | - |
| 2026-11-10 | P-2.2 top-up design, price and size | [Reviewed PR #178](https://github.com/bpmcginley/InternshipFinder/pull/178): proposed $3/25, spending order, full successful refunds, disputes, durable purchase retention/deletion and exact plan/terms wording. The note merge is refactor-owned; unspecified build choices remain with Bruce. Existing published pricing is unchanged. | - |
| 2026-11-10 | Stripe price and secret | After approved P-2.2 design, owner configures privately; never put private identifiers in the repo. | - |
| 2026-11-10 | Postal address and follow-email sending entitlement | P-2.1 note ready in #177. Verify onboarded domain, account-specific sending quota and capacity reserved for order mail before choosing volume; no guessed cap. | - |
| 2026-11-10 | Rename/topic/share the public GitHub list | Coordinate with existing PR #165; owner action. | - |
| 2026-11-10 | Record or approve an Auto-Apply demo clip | P-1.11 leaves space without claiming a demo exists. | - |
| 2026-11-10 | Extension merges and release after Stage 3 | Link reviewed PRs as ready; no release by this session. | - |
| 2026-11-10 | Monthly tool costs for cost review | Provide privately; no business figures in this public repository. | - |

## Measurement follow-up

After each package has been live for 14 days, assess its named aggregate counter using owner-provided read-only evidence. Record qualitative findings here; keep private business numbers out of this public repository. Do not infer results before the observation period. No automated production query or scheduled task has been created.
