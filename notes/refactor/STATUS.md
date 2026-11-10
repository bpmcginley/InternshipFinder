Formatting complete; wave 3 in progress

**Authorization update, 2026-11-10:** Bruce explicitly authorized processing now, finishing and merging retained PRs #165, #175, #177 and #178, and notifying the Product/Growth Refactor session to continue. This supersedes the 16:00 earliest-start and empty-queue holds below. Reviews, green CI, Pages verification, protected guard code/tests, and production deployment restrictions remain in force. Product has been notified; formatting is merged and published, and coordinated product work has resumed. Design-note merges do not resolve unspecified pricing, privacy, retention or operator choices, nor enable payment/email implementation. Historical notice and inventories below record the earlier gate.

Historical notice (superseded): this notice was published with PR #174 on **2026-11-10 at 12:40:47 America/New_York (17:40:47 UTC)**. Product session: from this notice, finish or close existing PRs and open nothing new until the formatting PRs merge, as `notes/product/HANDOFF.md` section 3 requires. The earliest formatting start is **2026-11-10 16:00 America/New_York (21:00 UTC)**, more than three hours after notice, and only after all other PRs clear. External PR #165 and remaining product PRs block that quiet window. Configuration-only work may proceed; no formatting changes have started.

Product additions of public files, including new-page PRs #181 and #182, need explicit entries in `scripts/site-allowlist.txt` as well as a reviewed golden refresh. The Pages publication boundary rejects new paths without allow-list entries.

# InternScout refactor status

Updated: 2026-11-10. Lead: Codex lead session. Instructions: [HANDOFF.md](HANDOFF.md); background: [ANALYSIS.md](ANALYSIS.md). The current user instructions and HANDOFF decisions supersede historical proposals in ANALYSIS.

## Current position

- Hand-offs found on `origin/refactor/handoff-docs` and read in full before the audit. [PR #167](https://github.com/bpmcginley/InternshipFinder/pull/167) merged as `00cf10e0` after independent review and all checks passed. Its only changes were these two internal documents.
- Wave 1 complete: internal notes, shared CI, type reports, golden build, and coverage reporting merged with independent reviews, green checks, and green Pages. Wave 2 lint configuration merged in PR #183 with green Pages run 42871996393. Existing PR integration and subsequent mechanical formatting are now authorized without the earlier time/queue gate; later waves still follow the ordered plan. All six baseline suites passed.
- Baseline is clean main `57202cae`, before refactor changes. The original checkout contains unrelated uncommitted work and is untouched. Implementation uses separate, explicitly owned worktrees and branches.
- All four retained PRs (#165, #175, #177 and #178) are merged under Bruce's explicit authorization, with independent reviews, green CI, and green Pages. PR #165 Pages run 42886670663 passed. Recheck open PRs and coordinate overlapping files before every wave; the authorization does not permit discarding others' work.
- Formatting is complete: JavaScript #189 and Python retry #192 are merged with green Pages runs 42891570445 and 42892197177 (duplicate 42892208901 also passed). Prior #190 was reverted by #191 after a deployment timeout; recovery Pages 42890454209 passed. Wave 3 implementation is active in isolated branches. Product #188 failed publication and was reverted by #197, merged as `e009644f`, preserving automated data refresh `79e85`. Product #197 recovery Pages run 42896131695 passed all jobs and its exact-commit backend check succeeded. The lead may resume serialized refactor merges after each PR satisfies its final review and CI gates.
- Pages runs on every push to main (`.github/workflows/pages.yml:14-16`), broader than the hand-off's examples. After every merge, verify the corresponding Pages run before the next merge. A failed publishing merge requires a new revert PR, independently reviewed and merged; never rewrite history.

## Execution rules

One package or explicitly listed subpackage per agent, worktree, branch, and PR. Workers do not merge. The lead merges only after all CI checks pass, a second agent reviews for behavior changes, golden output is unchanged or every difference is explained, and the change is within authorization. Update this tracker in every PR. Pick up main by merge, never by rewriting a shared branch.

Never force-push, deploy production services, run remote database commands, release the extension, or manually dispatch workflows that publish, send email, or post to social accounts. No secrets, private service identifiers, or personal profile data in code, logs, PRs, or notes. Preserve `MuseWork.md` and other checkouts. No changes to user-visible text, privacy policy, pricing, or data collection. The internal-note removal and automatic cache-version changes are approved. Stop only the affected package at a HANDOFF section 9 boundary, record the question here, and continue independent authorized work.

## Baseline verification

Environment: Python 3.12.10; Node 22.23.4 selected through `npm exec`. Commands checked against `.github/workflows/test.yml`. Results below are for clean main `57202cae`; installing test dependencies does not change tracked source.

| Suite | Command | Result | Notes |
|---|---|---|---|
| Backend | From `backend`: `python -m pytest tests/ -q` | 1,478 passed, 2 skipped in 123s | Intentional missing-cryptography and missing-ffmpeg skips; no test failures. |
| Worker Node | From `worker`: `node --test test/` | 333 passed | Runs SQLite-backed tests as well as pure helpers. |
| Worker runtime | From `worker`: `npm ci`, then `npm run test:workers` | Install succeeded; 11 passed in 5 files | Local workerd/D1; no production deployment or provider calls. |
| Extension | `node --test extension/test/*.test.mjs` | 345 passed | Guard module and guard tests remain protected. |
| Site | `node --test tests/site/*.test.mjs` | 244 passed | Includes checkout compatibility tests. |
| Extension packaging | `python -m unittest discover -s scripts -p 'test_release_extension.py'` | 2 passed | Reproducible packaging; no release. |

All six suites passed; tracked baseline files remained unchanged. The isolated dependency-install attempt could not build cryptography 50 on Windows ARM64 because the MSVC linker was unavailable. This is an environment limitation, not a failing main test: `backend/tests/test_metrics.py:408` intentionally skips without cryptography; `backend/tests/test_reels.py:71` skips without ffmpeg. The successful backend run used the available Python 3.12 environment. Full dependency coverage remains available in Linux CI; local skipped checks are not claimed as passes.

The documentation-only status PR also verified the complete backend suite in Linux CI: [PR #168 test run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42860747632), backend job `129986040297`, passed all 1,480 tests in 50.80s with cryptography and ffmpeg installed and no skips.

## Package tracker

`Queued` means not started, subject to its wave and dependencies. `Question` pauses only the named scope. Branch and PR cells are filled when assigned; no branch or PR is implied by a dash. Multi-PR packages are split into separate rows below.

| Wave | Package | Owner | Branch | PR | State | Next step / constraint |
|---|---|---|---|---|---|---|
| 0 | Status tracker | read_worker | `refactor/status-tracker` | [#168](https://github.com/bpmcginley/InternshipFinder/pull/168) | Merged | Independent review, green CI and green Pages. |
| 0 | WP-0.1 Internal notes | read_backend | `refactor/wp-0.1-internal-notes` | [#169](https://github.com/bpmcginley/InternshipFinder/pull/169) | Merged | Independent review, green CI, and green Pages run 42863632275. |
| 1 | WP-0.2 Golden build | read_backend | `refactor/wp-0.2-golden-build` | [#179](https://github.com/bpmcginley/InternshipFinder/pull/179) | Merged | Independent review, green Linux CI, and green Pages run 42866406265. |
| 1 | WP-0.4 Type checks | read_worker | `refactor/wp-0.4-type-reports` | [#172](https://github.com/bpmcginley/InternshipFinder/pull/172) | Merged | Independent review, green CI, and green Pages run 42865676691. |
| 1 | WP-0.5 Coverage | read_site_extension | `refactor/wp-0.5-coverage-reports` | [#174](https://github.com/bpmcginley/InternshipFinder/pull/174) | Merged | Independent review, green CI, and green Pages run 42867413022. |
| 1 | WP-0.6 Shared CI setup | Lead | `refactor/wp-0.6-shared-ci` | [#171](https://github.com/bpmcginley/InternshipFinder/pull/171) | Merged | Independent review, green CI, and green Pages run 42864974798. |
| 2 | WP-0.3 Lint configuration | read_worker | `refactor/wp-0.3-lint-config` | [#183](https://github.com/bpmcginley/InternshipFinder/pull/183) | Merged | Independent review, all nine CI checks passed, and green Pages run 42871996393; no formatting. |
| 2 | WP-0.3 Python formatting | Lead | `refactor/wp-0.3-python-format-retry` | [#192](https://github.com/bpmcginley/InternshipFinder/pull/192) | Merged | Independent final review, green CI and green Pages run 42892197177; merged as `182c02ce`. |
| 2 | WP-0.3 JavaScript formatting | read_site_extension | `refactor/wp-0.3-js-format` | [#189](https://github.com/bpmcginley/InternshipFinder/pull/189) | Merged | Independent review, green CI and green Pages run 42891570445. Safe subset formatted; protected/public/financial exclusions documented. |
| 3 | WP-1.1 Leftovers | read_backend | `refactor/wp-1.1-leftovers` | [#196](https://github.com/bpmcginley/InternshipFinder/pull/196) | In review | Backend 1,484 passed/two known skips; golden 695 unchanged; Ruff and move/reference/link audits passed. |
| 3 | WP-1.2 Python packaging | Unassigned | - | - | Queued | Classify growth tests before moving; preserve existing CLI invocations. |
| 3 | WP-1.3 Docs index | Unassigned | - | - | Queued / question | Index runbooks and refresh current rules; preserve model notes pending answer Q1. |
| 3 | WP-1.5 Cache versions | Unassigned | - | - | Queued | Approved built-HTML changes; explain golden updates. |
| 3 | WP-2.3 Worker contract | Unassigned | - | - | Queued | Inventory code routes and clients, not prose alone; include missing metrics route. |
| 3 | WP-4.1 Migrations | Unassigned | - | - | Queued / operator gate | Deduplicated baseline and local tests; no remote action or deploy-script change. |
| 3 | WP-4.4 Runner documentation | Unassigned | - | - | Queued | Preserve intentional Node/Workers scenario overlap. |
| 4 | WP-1.4 Logging foundation/sources | Unassigned | - | - | Queued | Shared helper plus source adapters; preserve default output text and stream. |
| 4 | WP-1.4 Pipeline/export logging | Unassigned | - | - | Queued | Coordinate shared helper ownership and stdout assertions. |
| 4 | WP-1.4 Page-build logging | Unassigned | - | - | Queued | Preserve default output; avoid concurrent seo_pages edits. |
| 4 | WP-1.4 Growth logging | Unassigned | - | - | Queued | Check external PR overlap and output contracts. |
| 4 | WP-2.1 Vocabulary inventory | Unassigned | - | - | Queued | Written inventory only; record meaningful differences as questions. |
| 4 | WP-2.4 Config | Unassigned | - | - | Queued | Inventory worker URL consumers before generating area modules. |
| 4 | WP-4.2 Orders split | Unassigned | - | - | Queued | File moves only; preserve exports, cycles, transactions, and mail behavior. |
| 5 | WP-3.1 Constants/helpers | Unassigned | - | - | Queued | One seo_pages owner; unchanged golden manifest. |
| 5 | WP-3.2 Sitemap/feeds/llms | Unassigned | - | - | Queued | After WP-3.1; unchanged golden manifest. |
| 5 | WP-3.3 Near family | Unassigned | - | - | Queued | Serial family PR; data/render split without output changes. |
| 5 | WP-3.3 Employer family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.3 Field family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.3 Pay family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.3 Numbers family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.3 Digest family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.3 Listing family | Unassigned | - | - | Queued | Serial family PR; unchanged golden manifest. |
| 5 | WP-3.4 Build orchestration | Unassigned | - | - | Queued | Explicit ordered steps; preserve outputs and eliminate cycles carefully. |
| 5 | WP-3.5 Import consumers | Unassigned | - | - | Queued | Point consumers to new modules; retain compatibility exports. |
| 5 | WP-4.3 Route table | Unassigned | - | - | Queued / question | Characterize responses first; financial wrapper changes paused under Q3. |
| 5 | WP-5.2 Background agent | Unassigned | - | - | Queued | Separate move-only PR; guard and tests untouched; no version bump. |
| 5 | WP-5.2 Onboarding | Unassigned | - | - | Queued | Separate PR; preserve UI text and reproducible packaging. |
| 6 | WP-2.1 Vocabulary code | Unassigned | - | - | Queued | After inventory and resolution of meaningful differences. |
| 6 | WP-2.2 Design tokens | Unassigned | - | - | Queued | After Phase 3; preserve inlined output and distinct values. |
| 6 | WP-5.1 Core modules | Unassigned | - | - | Question | Browser-support decision Q2 precedes implementation. |
| 6 | WP-5.1 App modules | Unassigned | - | - | Question | After core and Q2; preserve window.IS consumers. |
| 6 | WP-5.1 Buy modules | Unassigned | - | - | Question | Last, alone; checkout boundary Q3 and unchanged checkout tests. |
| 6 | WP-5.3 Shared pure code | Unassigned | - | - | Queued | Preserve profile/scoring/id semantics; package-time copies and staleness check. |
| 6 | WP-6.1.1 DATA_DIR | Unassigned | - | - | Queued | Single setting; default remains docs/data. |
| 6 | WP-6.1.2 Test fixtures | Unassigned | - | - | Queued | Replace verified real-data dependencies with fixed fixtures. |
| 6 | WP-6.1.3 Reader workflows | Unassigned | - | - | Queued | Separate data checkout with main fallback; preserve triggers and permissions. |
| 7 | WP-3.6 Jinja templates | Unassigned | - | - | Queued / optional | Only identical golden output; keep f-strings when exactness adds risk. |
| 7 | WP-6.1.4 Data branch | Unassigned | - | - | Queued | Normal push from current data; branch rules remain Bruce's. |
| 7 | WP-6.1.5 Ingest writer | Unassigned | - | - | Queued | Write data branch; preserve Pages-following-ingest behavior. |
| 7 | WP-6.1.6 Remove main data | Unassigned | - | - | Waiting for observation | Requires seven days of clean ingest/Pages after cutover; no history rewrite. |
| 7 | WP-6.2 Remove shims | Unassigned | - | - | Queued | Only after repository-wide old-import search is clear. |
| 7 | WP-6.3 Ingest timing | Unassigned | - | - | Queued | Report from logs; no production run triggered for measurement. |

## Verified findings and plan corrections

Evidence references below refer to clean main `57202cae`; line numbers can move in later packages. Distinguish source evidence from observed test execution and production state.

### Worker audit

Full reads completed: `worker/src/index.js`, `worker/src/orders.js`, `worker/schema.sql`, and `worker/package.json`.

1. **Extra schemas are already included in schema.sql, contrary to the hand-off.** `worker/package.json:8` applies `schema.sql`. `worker/order-mail-schema.sql` is an exact substring at `worker/schema.sql:602-618`; `worker/campaign-report-schema.sql` is an exact substring at `worker/schema.sql:662-690`. Git history contains their integration in `14630f14` and `27b90dab`. Extra-file references are in Node tests. This proves the checked-in deploy path includes them, not that any particular production execution happened. Prepare one deduplicated baseline, not redundant migrations representing already-included objects. Operator verification is required before marking production migrations applied.
2. **Schema size correction:** 42 `CREATE TABLE` statements, not 45. Migration equivalence must include indexes, triggers, and the account/inviter backfills at `worker/schema.sql:402-433`, not just table names. Never change the deploy script before Bruce completes the documented production adoption step.
3. **Runner correction:** `worker/test/helpers.js:3,15-49` uses in-memory `node:sqlite` behind a D1 adapter. These are not all pure-logic tests. `worker/test/settlement-race.test.js` and `worker/test-workers/settlement-race.test.js` intentionally execute a shared scenario with both adapters. Keep this overlap; document fast Node/SQLite/provider-mock tests versus actual workerd/local-D1 integration. All Node test files are imported by `worker/test/index.js`.
4. **Runtime documentation correction:** `worker/README.md:65` says Node 20+, while the test helper needs `node:sqlite` and CI uses Node 22 (`.github/workflows/test.yml:50-62`). Use the CI version for verification.
5. **Contract completeness:** 42 exact method/path cases plus `/social-video/` prefix handling (`worker/src/index.js:103`), global OPTIONS (`:485`), and fallback 404. `GET /admin/employer-metrics` (`:369-373`) is absent from API.md. Inventory implementation and callers, rather than treating prose as complete.
6. **Router preservation requirements:** trailing-slash normalization, media GET/HEAD/method/range behavior, global preflight, error CORS, media error cache control, feature-check/auth ordering, and background work must stay identical. Auth differs among provider tokens, sessions, demand/admin tokens, and signed employer links. Financial wrapper changes encounter Q3.
7. **Orders seams verified:** 1,377 lines and 39 exports. The six suggested modules alone omit natural homes for shared helpers, role-index access, webhook settlement, email construction, and cron orchestration. Durable outbox logic already exists in `worker/src/order-mail.js`; reuse it. Preserve the existing `billing.js:8 -> orders.js -> billing.js` dependency semantics and all compatibility exports.

| Orders responsibility | Current orders.js lines | Refactor constraint |
|---|---|---|
| Constants, validation, token helpers; order loading | 29-172; 422-430 | Shared internal module; no eager initialization changes. |
| Role-index reader | 173-223 | Preserve validation, caching, and failure behavior. |
| Capacity and availability | 225-420 | Preserve transaction boundaries and reservation ordering. |
| Order creation and checkout | 432-629 | File moves only. |
| Paid-event settlement and disputes | 631-769 | Preserve webhook idempotency and existing billing cycle. |
| Signed review UI and decisions | 771-998 | File moves only; no visible text or financial logic changes. |
| Credits/refunds | 1000-1086 | File moves only; preserve durable choice claims. |
| Cron and recovery orchestration | 1088-1240 | Preserve job order, retry behavior, and retention. |
| Admin list and pilot codes | 1242-1268 | Preserve atomic pilot limit. |
| Email construction | 1270-1377 | Preserve exact text; use existing durable outbox module. |

### Build and workflow corrections

- Pages publishes on every main push, so the lead checks the associated run after every merge, including notes-only merges.
- WP-0.2 must exercise the actual `export_static` and `seo_pages` command entry points, including role index, widget data, placements, and page-date handling. Calling only a convenient internal `build()` function is insufficient. `backend/tests/conftest.py:31-37` defaults NEAR_ON to false outside near-page tests; golden fixtures must explicitly enable it. Pin earning-path state (`seo_pages.py:3301`), clock fallback (`:3309`), placement clocks (`:4055,4209`), previous sitemap/page hashes and page-date refresh/write (`:4063,4136`). Include role index (`:4229-4231`), feeds and widget data (`:4238-4240`).
- Wave 1's claim that all packages own different files needs coordination: type-check CI, coverage CI, shared CI setup, and golden CI can overlap. Allocate separate files or serialize integration; all packages still receive separate PRs.
- The lead read all 12 workflow files in full. Baseline backend count is 1,480 collected tests (1,478 passing, two skipped), rather than the hand-off's older 968 count.
- Notes inventory confirms 18 coverage-research files and three product-review files. Product-review CONTEXT contains a private conversation link, machine-local paths, and access history. Do not copy those values into this tracker, PRs, or logs; remove these notes from published artifacts through WP-0.1.
- `docs/widget/README.md` is public career-center integration documentation, verified by reading it in full. Preserve that URL with an exact allow-list entry. WP-0.1 acceptance is no internal Markdown notes in the artifact; it does not ban this intentionally public documentation. Reject any other unexpected Markdown path.
- Onboarding has no hard-coded taxonomy: its fields are free text. Majors are generated from `backend/internscout/majors.py` through `majors.json`; do not replace this existing generated path with an assumed duplicate. Detailed vocabulary evidence will be recorded in the inventory.

### Site and extension audit

Full reads completed: `docs/index.html`, `docs/js/core.js`, `docs/js/app.js`, `docs/js/buy.js`, `extension/manifest.json`, `extension/background/agent.js`, and `extension/agent/guard.js`; bridge and theme sources were also inspected.

1. **Bridge correction:** `extension/bridge/bridge.js` uses postMessage, runtime ports, and dataset; it never reads `window.IS`. The page bridge is at `docs/js/core.js:822`, IS export at `:1256`, and actual app consumer at `docs/js/app.js:6`. Buy, placement, and offer scripts expose `ISBuy`, `ISPlace`, and `ISOffer`. Preserve real consumers and load order rather than an assumed extension dependency.
2. **Vocabulary scope:** `core.js:9,22` has state/province maps; `:42,45` years/stages; `:64` derives terms from the clock; `:74` contains sparse field-label overrides duplicated in `buy.js:84`. Buy's fallback coercion/empty handling differs, so preserve it. Majors/fields are loaded at `core.js:802` and `app.js:638`. Onboarding's eligibility/citizenship definitions (`onboarding.js:658-683`) are different concepts from site work authorization (`core.js:67`), not taxonomy duplicates. Guard state-name copies near `guard.js:485,519` remain protected. No extension scoring implementation was found to justify an assumed scoring deduplication.
3. **Token inventory correction:** canonical light/dark/coarse maps match across `docs/index.html:124`, `docs/employers/index.html:47`, `docs/employers/buy/index.html:28`, `seo_pages.py:1298`, and `extension/lib/theme.css:14`: 56 light variables, 19 dark overrides, three coarse overrides. The 57 unique names includes local `--i`. Existing `tests/site/tokens.test.mjs` covers these five plus an overlay subset. Include buy and extension in the inventory, preserving all values; adapt source-reading tests when CSS moves. No value disagreement found that requires a decision.
4. **Cache counts correction:** five of six handwritten count.js tags lack versions, not four of five. Main index has versioned core/app/count (`index.html:757,761,800`) and unversioned placements/offer (`:760,764`). Buy has its own manual version (`employers/buy/index.html:240`) and unversioned count (`:241`); employers/install/terms/privacy also lack count versions. Generated OFFER_TAG (`seo_pages.py:1212`) is unversioned; beacon generation (`:1413`) imports the homepage tag. Hash URLs after all generation.
5. **Config count correction:** the endpoint string occurs in six product files (`docs/index.html`, `docs/js/count.js`, `docs/js/buy.js`, `docs/employers/index.html`, `extension/lib/config.js`, `growth/social.py`) plus `backend/tests/test_reels.py`. Extension configuration is already centralized; account for worker orders' independently overridable review URL.
6. **Real-data test dependencies:** `tests/site/dashboard.test.mjs:95,113,129` enumerates shards and majors and asserts more than 1,000 listings; `placements.test.mjs:46,56,81` reads five shards/majors and asserts more than 500; `first_screen.test.mjs:90-95` conditionally skips without first.json, then reads index/first/shards. Fixture conversion must keep first-screen coverage active. `core.test.mjs` does not read actual listing files despite an old source comment.

### Backend and internal-note audit

Full reads completed: `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, all of `backend/internscout/seo_pages.py`, `export_static.py`, `pipeline.py`, and `run_ingest.py`. All Markdown in both internal-note folders was read; their JSON was recursively parsed and scanned. No credential-shaped or private-service-label matches were found, which is not a guarantee that every value is non-sensitive. Private conversation links, local paths, and access history are not reproduced here.

1. **Leftovers verified:** repository search excluding listing data, git internals, and protected MuseWork found only `run.sh:11` starting `internscout.api`; `api.py:5-7` imports FastAPI and `:17,142` references frontend. Dependency pins are `backend/requirements.txt:1-2`. No active caller outside this legacy chain was found. Keep db/models, imported by `pipeline.py:10-11` and `export_static.py:20-21`. `insights.py:35` mentioning FastAPI is a classification regex, not an API dependency.
2. **Notes move references corrected:** update `AGENTS.md:16`, `backend/tests/test_scan_completeness.py:276`, `backend/internscout/sources/workday.py:135`, and moved coverage `CONTEXT.md:7`. The hand-off-named `reviews/2026-10-16-post-release/STATUS.md` contains no actual moved-directory reference, so no edit is needed there. Coverage JSON contains public ATS/listing identifiers, listing titles, and timings.
3. **Growth test count corrected to 18:** `test_cards`, `test_catchup`, `test_campaign`, `test_every_major_list`, `test_digest_schedule`, `test_digest_send`, `test_digest`, `test_indexnow`, `test_instagram_carousel`, `test_instagram`, `test_reels`, `test_metrics`, `test_outreach`, `test_report`, `test_search_reporting`, `test_social`, `test_title_discovery`, and `test_youtube` are the candidate `.py` files. Search hits in query_expansion, role_index, and placement_runs are not pure growth tests; keep them in backend. campaign (`:15`), instagram_carousel (`:15`), and title_discovery (`:13`) import `_row`/`_site` from test_seo_pages; relocate shared helpers or preserve explicit cross-suite support. Transfer backend conftest safety/event/environment fixtures when moving tests so coverage and isolation remain intact.
4. **Logging measurements corrected:** 178 print calls confirmed; 45 broad exception handlers, not 19 (32 backend, 13 growth). Preserve stdout, exact text/newlines, ordering, and stderr exceptions: malformed SEO rows (`test_seo_pages.py:555`), metrics JSON stdout (`test_metrics.py:339`), and placement CLI newline/security assertions (`test_placement_runs.py:203-223`), plus growth capsys assertions. Default logging prefixes or stderr redirection would change behavior. Do not log raw exceptions containing sensitive request values.
5. **Taxonomy inventory:** `majors.py:120` derives major exports from classifier field/stage/year keys. True state-map candidates are `geo.py:27`, `seo_pages.py:228,245`, and `core.js:9,22`, but their DC display labels differ; preserve each existing presentation and record Q4 before any normalization. `near_metros.py:63` FIELD_TAGS repeats top-degree-field tags. `config.py:50` BASELINE_STATES versus `seo_pages.py:573` HOME_STATES and `focus.py:61` HOME includes a remote derivative. These are candidates for generation, not permission to collapse distinct representations.
6. **Derived or different concepts:** coverage CLUSTERS/SECTOR_CLUSTER are groupings derived from classifier sectors; core YEARS/STAGES are labels; core FIELD_NAMES and SEO FIELD_TITLES serve aliases versus headings/slugs; SEO PLACES is derived after province/metro updates. source_discovery SECTORS is research grouping, growth title-discovery FIELDS/STATES is a marketing cohort, ingest_metrics STAGES is pipeline metrics, oracle FIELDS describes response fields, and listing_audit DEFAULT_FIELDS selects a sample cohort. Do not equate matching names with duplicate semantics.
7. **Data-fixture scope:** the site dependencies above are verified. `backend/tests/test_site_links.py:48` deliberately excludes data. No direct extension shard dependency was found. Preserve diverse comparison cases and meaningful count checks in fixed fixtures rather than merely lowering thresholds.

### Verification inventory

| Hand-off verification item | State | Required evidence before its package starts |
|---|---|---|
| Public notes contents and references | Verified in source | Contents and corrected reference list above; preserve public widget README. |
| Unused frontend/run.sh/api.py and dependencies | Verified in source | Only legacy chain found; keep DB/models and classification vocabulary. Recheck at implementation. |
| Pure growth test classification | Verified in source | 18 candidates; preserve shared helper imports and transferred conftest isolation. |
| Stdout assertions for logging | Verified in source | Tests and CLI contracts above; preserve text, stream, ordering, and exit status. |
| Vocabulary duplicates versus derived views | Verified in source | Free-text onboarding is not taxonomy; distinct labels/groupings remain distinct. Inventory PR before generator; Q4 gates normalization. |
| Extension dependence on window.IS | Verified; hand-off claim corrected | Bridge does not read IS; preserve actual page consumers and load order. |
| Tests using repository listing data | Verified in source | Site paths listed above; fixture conversion must not create silent skips or weaken comparisons. |
| Extra SQL application mechanism | Verified in source | Included verbatim in schema.sql; production application history remains operator-owned. |
| Orders natural seams | Verified in source | Grouping above; retain existing outbox and compatibility exports. |

## Work-package validation

### WP-0.1 Internal notes

- Moved all 18 coverage-research files and three product-review files into `notes/`; updated the four verified pointers. Public widget integration README remains byte-identical and explicitly permitted. The approved behavior change removes the two internal-note URL trees from subsequent Pages artifacts.
- Added a reviewed file-pattern allow list and a checker that enumerates files without following symbolic links or Windows junctions. Unknown files, hidden files other than `.nojekyll`, unexpected empty directories, and filesystem links fail before artifact upload. Only the public `widget/README.md` Markdown file is allowed. Pages runs the checker tests and prints the checked inventory before upload.
- Local actual build: copied current `docs/` into a temporary validation directory, removed CNAME as Pages does, and ran `python -m internscout.seo_pages` with an explicit empty placements fixture. It generated 2,106 pages and a role index containing 18,717 roles. No live fetch, service write, or deployment was performed.
- Full artifact check: 4,334 files accepted. `python -m internscout.site_links` checked 2,115 HTML pages and 195,643 internal references, with zero missing references or redirects. Copied an injected `docs/stray.md` into the artifact and confirmed exit 1 naming the unexpected file; removed both fixtures and confirmed the clean artifact passes again. A real Windows junction root was also rejected.
- Tests: `python -m pytest tests/test_scan_completeness.py tests/test_site_links.py -q` from backend: 75 passed. `python -m unittest discover -s scripts -p 'test_site_contents.py'`: four passed, one skipped because Windows does not permit symbolic-link creation here; the same test runs on Linux in Pages. The separate real junction check passed. `git diff --check` passed.
- First PR CI found one introduced workflow-contract failure: [run 42862662508](https://github.com/bpmcginley/InternshipFinder/actions/runs/42862662508) reported 1,479 passed and one failed. `test_placement_runs.py` requires the existing paid-listing report step immediately after the build. Moved only the new validation step after that report and before Pages configuration/upload, preserving the original adjacency and leaving the financial code, report step, and contract test unchanged. Reran `python -m pytest tests/test_placement_runs.py -q`: all 14 passed; checker tests and the 4,334-file artifact check also passed again. New-head CI and independent review are required before merge.
- Golden output comparison is not yet available: WP-0.2 follows this package. Public source assets and generator code are unchanged; the planned output difference is removal of the two internal-note trees.
- After the green Pages publication, lead read-only HEAD requests verified `/coverage-research/README.md` and `/product-review/CONTEXT.md` return 404, while `/widget/README.md` remains 200. No response bodies were fetched.

### WP-0.4 Report-only type checks

- Added Pyright basic mode for `backend/internscout` and `growth`, with Python 3.12 and the existing backend import root. Added worker `checkJs`/`noEmit` configuration for `worker/src` with ES2022 and WebWorker globals. Runtime sources, existing workflows, and worker dependencies are unchanged; no type suppressions or source fixes were added.
- Root developer tools are locked to Pyright 1.1.414 and TypeScript 7.0.2. TypeScript's actual CLI was validated on Node 22.23.4, rather than assuming the older compiler API. `npm ci --ignore-scripts` succeeds.
- Commands: `npm run typecheck:python` and `npm run typecheck:worker`; append `-- --output <path>` to save a sanitized JSON report. Existing type errors are report-only and return success; missing/broken tools, invalid configuration, and unusable reports fail the command. Worker enforcement remains deferred because the baseline is not zero.
- Local baseline on source main `9f739770`, Python 3.12.10, Node 22.23.4: Pyright **124 errors, 13 warnings**; worker TypeScript **914 errors, no warnings**. Python's local dependency limitations from the baseline section still apply. Linux CI with backend requirements, Pillow, and cryptography reports **129 Python errors, 13 warnings**, and **914 worker errors, no warnings** ([type report run 42864679706](https://github.com/bpmcginley/InternshipFinder/actions/runs/42864679706)). These are separate environment baselines, not newly introduced code errors or fixes; use Linux CI for subsequent comparisons.
- Diagnostic stdout/stderr is captured without being printed. Reports contain only counts plus constrained repository-relative paths, line/column, severity, and rule identifiers. Messages, source snippets, exception stacks, and unknown diagnostic fields are discarded to prevent existing private literals from appearing in logs or artifacts. The new CI workflow uploads only these sanitized reports.
- Validation: all three sanitizer tests pass locally and in Linux CI, covering message/continuation removal, path restrictions, and configuration failures. Both real checkers complete and produce the counts above; the site suite passes all 244 tests. Golden output is not yet available; no production build inputs or runtime code changed.

### WP-0.5 Coverage reports

- Added a separate, read-only-permission coverage workflow on main pushes and pull requests. Existing workflows and normal test commands are unchanged. Coverage has no minimum thresholds; failing tests still fail the job. Artifact upload runs after failures to retain available diagnostics, without swallowing the failed test step.
- Pinned `pytest-cov` 7.1.0, coverage.py 7.17.2, and `c8` 12.0.0. The worker lockfile adds coverage-only development dependencies; no existing package versions changed or packages were removed. A clean Node 22 `npm ci --ignore-scripts` succeeded locally.
- Python command from backend: `COVERAGE_FILE=../coverage/python/.coverage python -m pytest tests/ -q --tb=no --show-capture=no --cov=internscout --cov=../growth --cov-report=term --cov-report=xml:../coverage/python/coverage.xml` (set the environment variable using the current shell). Python 3.12.10: 1,478 passed, two known missing-cryptography/ffmpeg skips in 174.62s. Line coverage: 9,897 / 11,227, or 88.15%, across 87 backend/growth files, including unexecuted modules. Branch coverage is not collected for Python in this initial report.
- Node command from worker: `npm run test:coverage` under Node 22.23.4. The existing worker, extension, and site suites passed. C8 includes all production JS in the three areas, excludes tests and extension vendor code, and includes unexecuted files in the denominator. Line coverage: worker 5,394 / 5,473 (98.56%, 22 files); extension 6,532 / 9,103 (71.76%, 37 files); site 2,499 / 4,690 (53.28%, six files). Combined: 14,425 / 19,266 (74.87%). These are coverage-run measurements, not production usage or browser coverage.
- Existing VM tests often omit filenames. A coverage-only preload supplies a filename only when the entire source string exactly matches one unique production file. It does not modify source, guard code/tests, or test behavior. Modified scripts and snippets remain unattributed; notably, app.js reports zero despite component tests. Three focused attribution tests passed. A deliberately failing child process returned its original exit code through c8, confirming failures are not converted to success.
- Artifacts are explicitly limited to Python Cobertura XML, Node LCOV, and Node JSON summary. Their structures contain paths, names, line numbers, and counters, not source bodies. No HTML reports, raw V8 data, source maps, coverage databases, or test-output logs are uploaded. Generated files stay ignored under coverage/. Node uses the dot reporter and Python suppresses tracebacks/captured output to avoid copying legacy source values into diagnostics.
- Before golden integration, [Linux coverage run 42865852643](https://github.com/bpmcginley/InternshipFinder/actions/runs/42865852643) passed all 1,480 Python tests with no skips in 102.91s: 9,925 / 11,227 covered lines (88.40%). Node coverage matched local counts exactly. Downloaded CI artifacts contain only coverage.xml, lcov.info, and coverage-summary.json; their field structures contain no source bodies. Final-head CI includes the two added golden tests.
- After merging WP-0.2, `python backend/tests/golden_build.py` passed: all 687 output hashes matched. Runtime sources, public assets, generators, and test assertions are unchanged; public output difference: none. The committed golden fixture and manifest were not edited.

### WP-0.2 Golden build

- Added a test-only harness that stages production code and public static assets in an isolated temporary directory, omits real `docs/data`, seeds SQLite with 300 fixed synthetic listings, and runs the actual `export_static`, `seo_pages`, and `site_links` module entry points in separate subprocesses. No production clock hook or workflow edit is needed. Near-page generation retains its production setting, outside pytest's autouse override.
- Fixed the UTC clock before imports, locale, hash seed, previous sitemap/noindex set, Search Console evidence, placements, prior page-content dates, empty previous export, and absent geocode cache. The subprocess environment excludes user config and credentials. Geocoding is disabled and socket/DNS attempts fail even if a production helper tries to swallow the error.
- The initial artifact has 687 hashed files, including 501 near HTML pages, 73 feeds, eight employer pages and their hub, 147 cohort-detail records, active placement content, and all required page families. Fixed inputs also exercise a rejected expired placement and both retained and advanced content dates. The compressed review archive contains only the public fixture build's output bytes.
- Windows text inputs are normalized to Linux checkout LF before building; generated output bytes are never normalized before SHA-256 comparison. Binary assets remain exact. The explicit refresh command and product-session baseline-update rule are documented in `backend/tests/fixtures/golden/README.md`.
- Validation: the golden tests passed twice consecutively (two tests in 20.94s and 27.92s), including a one-character footer-template mutation rejected with changed-file diagnostics and a short diff. Full local backend: 1,480 passed and the same two environment skips in 97.15s. Independent review verified all 687 archive members exactly match manifest hashes and all fixture URLs use the reserved example domain. Linux CI passed before the lead merged PR #179.

### WP-0.3 Lint configuration only

- Added pinned Ruff 0.17.4, ESLint 10.14.0, and Prettier 3.9.10 developer tooling. Existing Pyright/TypeScript pins and scripts remain unchanged; the root package still has no module-type declaration. No runtime source, user-visible text, or generated output was changed.
- Ruff checks `backend`, `growth`, and `scripts` with Python 3.12 syntax and initial E9/F63/F7 correctness rules. ESLint checks worker, extension, site JavaScript, and tests with eight initial correctness rules (constructor super, class assignment, negative-zero comparison, duplicate args/cases, invalid native constructors, unsafe negation, and typeof comparisons). Both rule sets pass the current source without runtime fixes or per-file suppressions.
- The new lint workflow uses shared setup actions, pinned installs, sanitizer tests, and check-only commands: `npm run lint:python` and `npm run lint:javascript`. Lint errors, invalid configuration, and unusable tool reports fail CI. Diagnostics expose only constrained paths, locations, severity, and rule identifiers, never messages, source snippets, suggestions, or exception stacks.
- Future commands are `npm run format:python` and `npm run format:javascript`; neither has been run. Formatter configuration uses LF and disables embedded-language formatting. JavaScript targets exclude vendor/minified code, generated/data assets, MuseWork, the guard module, direct and transitive guard tests, and takeover/ownership safety regressions. Format-clean CI is deferred until the separate mechanical PRs have landed. Any byte changes to published JavaScript will require the lead's explicit golden-output handling before that formatting package can proceed; this configuration PR does not refresh golden files.
- Local validation: both linters report zero errors and zero warnings. Sanitizer and formatter-ignore tests pass without formatting any source. Golden build matched all 687 files before and after normally integrating product PR #176 (`898e4327`), preserving its source and reviewed manifest/archive together. After normally integrating product flyer PR #181 (`ad180f0d`), both linters remained clean and the golden build matched all 691 files, preserving its source and reviewed manifest/archive. The subsequent automated data refresh (`13a71aad`) was also integrated. No golden refresh was performed in this package. Final CI and independent review remain required.
- Remaining open PRs were checked before work; configuration paths are unclaimed by product. Formatting waits for the notice period and every other PR to clear. Later waves remain queued; no scope is skipped to work around this gate. Existing user questions below remain unchanged.

## Questions and external gates

| ID | Affected scope | Question / gate | Current handling |
|---|---|---|---|
| Q1 | WP-1.3 model notes only | May the stale October model-choice notes be removed from AGENTS.md? HANDOFF explicitly reserves this decision. | Preserve them; docs index/current rules can proceed. |
| Q2 | WP-5.1 | Is native ES-module browser support acceptable? HANDOFF requires confirmation before implementation. | Record question now; independent work continues. |
| Q3 | WP-4.3 financial routes; WP-5.1 buy | May checkout/refund routing move beyond file moves into new auth/limiter wrappers or module integration? Section 9 requires a decision for that scope. | Contract inventory and characterization may proceed; financial behavior restructuring remains paused. |
| Q4 | WP-2.1 state-label normalization only | State maps use different DC display labels. Are these intentional presentation differences? | Inventory and generation may preserve distinct representations; no silent label unification or user-visible text change. |
| G1 | WP-4.1 adoption | Bruce verifies actual production schema and marks the baseline migration applied; deployment-script change follows only afterward. | Prepare and test locally; no production commands. |
| G2 | WP-0.3 formatting | Original 16:00 Eastern and empty-queue restrictions superseded by Bruce's explicit 2026-11-10 instruction to finish queued PRs and proceed now. | Continue file ownership, separate worktrees, independent review, green CI and Pages gates. |
| G3 | WP-6.1.6 | Seven days of clean ingest and Pages after data-writer cutover. | No cutover yet; observation clock has not started. |

## Waiting for deploy

- [PR #175](https://github.com/bpmcginley/InternshipFinder/pull/175), merged as `f4504cb1`: counter allowlist expansion remains undeployed. Approved and published disclosure plus explicit operator deployment are still required. No worker/database deployment or extension release was performed.

## Merge and publication ledger

| PR / package | Commit | Review / CI | Pages | Result |
|---|---|---|---|---|
| [#167 Hand-offs](https://github.com/bpmcginley/InternshipFinder/pull/167) | `00cf10e0` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42859546750) | Merged; documentation only. |
| [#168 Status tracker](https://github.com/bpmcginley/InternshipFinder/pull/168) | `64fd6400` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42861453089) | Merged; documentation only. |
| [#169 Internal notes](https://github.com/bpmcginley/InternshipFinder/pull/169) | `9f739770` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42863632275) | Merged; approved internal-note URL removal. |
| [#171 Shared CI setup](https://github.com/bpmcginley/InternshipFinder/pull/171) | `fc9f1fca` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42864974798) | Merged; effective workflow behavior preserved. |
| [#172 Type reports](https://github.com/bpmcginley/InternshipFinder/pull/172) | `c6ef372f` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42865676691) | Merged; report-only developer tooling. |
| [#179 Golden build](https://github.com/bpmcginley/InternshipFinder/pull/179) | `2489edca` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42866406265) | Merged; fixed offline build and 687 output hashes. |
| [#174 Coverage reports](https://github.com/bpmcginley/InternshipFinder/pull/174) | `10f28db5` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42867413022) | Merged; report-only coverage with source-free artifacts. |
| [#183 Lint configuration](https://github.com/bpmcginley/InternshipFinder/pull/183) | `3923879c` | Independent agent review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42871996393) | Merged; no formatting or runtime edits; 691 golden files unchanged. |
| [#177 Follow design](https://github.com/bpmcginley/InternshipFinder/pull/177) | `aef83ea3` | Independent review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42884666843) | Merged; design notes only, implementation choices remain gated. |
| [#178 Top-up design](https://github.com/bpmcginley/InternshipFinder/pull/178) | `4445cbb5` | Independent review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42884967351) | Merged; design notes only, payment implementation remains gated. |
| [#186 Product status](https://github.com/bpmcginley/InternshipFinder/pull/186) | `ad3fca40` | Green CI | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42885443353) | Merged; product coordination ledger preserved. |
| [#175 Counter integration](https://github.com/bpmcginley/InternshipFinder/pull/175) | `f4504cb1` | Independent review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42886167129) | Merged; disclosure and operator deployment remain pending. |
| [#165 Directory monitoring](https://github.com/bpmcginley/InternshipFinder/pull/165) | `824b8a42` | Independent review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42886670663) | Merged under explicit retained-PR authorization. |
| [#190 Python formatting](https://github.com/bpmcginley/InternshipFinder/pull/190) | `f38bd93e` | Independent review; all CI green | [Deployment timed out](https://github.com/bpmcginley/InternshipFinder/actions/runs/42887701389) | Reverted by #191 under HANDOFF section 3; build and golden output had passed. |
| [#191 Publishing recovery](https://github.com/bpmcginley/InternshipFinder/pull/191) | `8cf6add6` | Independent exact-tree review; all nine checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42890454209) | Ordinary revert preserved history; retry #192 later reapplied reviewed formatting. |

## Next update

Product #197 recovery publication and backend checks are verified green. Resume serialized Wave 3 merges after each package has final independent review and green CI. WP-1.1 PR #196 is ready for that sequence. Preserve current product/data history, separate ownership, and Pages verification after every merge; later waves remain ordered.

## WP-0.6 validation and coordination

- Product-session coordination read from PR #170 (`notes/product/HANDOFF.md` section 3 and the new refactor section 4 bullet). Refactor has structural right of way; inspect product draft PR claims before each wave. Before formatting, publish "Formatting PRs next" at the top of this tracker and allow a few hours for product PRs to clear. Do not alter product-owned work.
- WP-0.1 merged as `9f739770`; [Pages run 42863632275](https://github.com/bpmcginley/InternshipFinder/actions/runs/42863632275) is green, including the publication boundary tests.
- WP-0.6 adds Python 3.12/optional-backend-install and Node 22 composite actions. Sparse checkouts using a local action include `.github/actions`. Each of the 12 existing workflows uses shared setup. New wave-1 report workflows have separate owners and are not edited by this package.
- Parsed before/after YAML: workflow/job metadata (including triggers, conditions, permissions, concurrency, schedules, environment, timeouts) unchanged. Expanded shared actions and compared effective steps after ignoring comment-only lines; commands, environments, conditions, and order match. The deliberate setup difference is release.yml now explicitly selects Python 3.12 and Node 22, matching the existing test workflow rather than inheriting runner defaults. No extension release was run.
- Relevant workflow-contract tests: 39 passed. The first test invocation from the repository root failed collection because the package is not installed yet; rerunning from the documented backend directory passed. This was invocation context, not a main failure or code change.
- No runtime source, public output, or dependency versions used by product code changed. Golden validation will be run if WP-0.2 lands before this PR.

## Historical wave-2 checkpoint (before authorization override)

- Completed: initial hand-off and tracker, all wave-0/1 packages, and the configuration-only part of WP-0.3. The full refactor is not complete. No mechanical formatting or later-wave implementation has begun.
- The initial six-suite baseline and every marked verification item are recorded above, including corrections to the hand-off. New tests, lint, types, coverage, and golden jobs now run in CI. Existing type debt remains report-only; coverage has no thresholds.
- The open-PR inventory at 18:13 UTC (13:13 Eastern) on 2026-11-10 contains #165, #175, #177, #178 and #180. These must clear before mechanical formatting under WP-0.3 and the product coordination rule. Preserve their branches and work; this session has not closed or merged them.
- Original uncommitted work and MuseWork.md were not edited. No force pushes, history rewriting, worker/database deployment, extension release, paid AI calls, real submissions, outreach, or manually triggered publishing workflows were performed. Normal main merges triggered the existing Pages workflows, which are verified in the ledger.

## Formatting readiness follow-up (2026-11-10)

- Fetched main at `4144e5ae`. PR #180 has merged; its Pages run 42876965306 and subsequent data-refresh Pages run 42877725984 passed. Four PRs remain open: #165, #175, #177 and #178. No formatting has run. The 16:00 Eastern earliest start and empty-queue requirement remain in force.
- **Q5, coordination:** product STATUS records Bruce's explicit instruction to retain #175, #177 and #178 for review; #165 belongs to another session. This prevents satisfying the empty-queue rule. Asked Bruce whether these four retained PRs may be exempt after the notice period or whether formatting must continue waiting. No exemption is assumed.
- Read-only JavaScript scope audit: the pinned Prettier command covers 142 eligible tracked files; guard.js, its protected direct/transitive tests, vendor and minified assets remain excluded. Source-inferred obstacle: protected `extension/test/batch_focus.test.mjs:63,98,147` matches exact source layout in eligible implementation files. Formatting could break it; do not edit the protected test. Preserve those implementation regions or narrow scope if confirmed during an authorized formatting run.

## Authorized PR #165 integration

- Q5 is resolved by Bruce's subsequent instruction: finish and merge the retained existing PRs, including #165, now; the 16:00 Eastern and empty-queue gates are lifted. Other authorization boundaries and merge checks remain unchanged. The earlier waiting-state entries are historical.
- Created a separate owned integration worktree from PR #165's existing head, then merged main normally. Read all seven original changed files in full. The new weekly directory workflow uses the shared Python action after a full checkout; its schedule, read-only permissions, command and artifact retention are unchanged by integration.
- Explicitly authorized behavior: a weekly public-directory GET check with robots handling and unknown status for blocked/unrecognizable pages; one how-to paragraph added to the separately generated every-major README; dated research and draft guidance. No directory check, message, submission, manual workflow run, or remote write was performed during validation.
- Focused tests: 25 passed (`test_directory_monitor.py`, `test_every_major_list.py`, `test_outreach.py`). The full offline Pages golden build matched all 695 files without a refresh. A separate network-disabled generator comparison on synthetic golden data produced 11 Markdown files: all ten field files were byte-identical; only README gained the approved paragraph. A second generator pass was identical. `git diff --check` passed.
- Second-agent review and final-head CI are required before the lead merges PR #165; Pages verification follows that merge.
- Golden copies public assets verbatim (`backend/tests/golden_build.py:43`), so formatting eligible `docs/js` files can alter output hashes even when runtime behavior is unchanged. Do not silently refresh the manifest. Review every affected output and resolve the hand-offs' baseline restrictions before proceeding. The blanket JavaScript command also includes financial modules, which remain subject to section 9 and Q3. These are source-inferred risks, not observed formatter or test failures.

## Retained PR #175 integration

Bruce authorized the refactor lead to finish and merge this existing counter PR. Integration uses an isolated worktree and normal main merge, preserving upstream product work. Local Node 22.23.4 validation: worker 336 passed, Workers runtime 11 passed in five files; golden output matched 695 files without refresh. Final independent review and CI remain required. The only runtime change is the original fixed 16-name allowlist expansion; no client emitters, schema, published privacy policy, or deploy configuration changed. Proposed disclosure still requires approval and publication before an operator deploys the worker. No worker deployment or production database command was performed.


## Publishing recovery: PR #190

- Python formatting PR #190 merged as `f38bd93e` after independent exact-AST/comment/golden review and all nine CI checks passed. Pages build succeeded, but deployment was cancelled at its ten-minute timeout: run 42887701389, deployment job 130081009359. No later main push superseded it. No source/test/build failure was reported; deployment did not finish green.
- Per HANDOFF section 3, prepared a new revert PR immediately. It reverses merge #190 with an ordinary revert commit, preserving all four retained PR merges and history. No manual publishing workflow was dispatched. The 166-file Python formatting remains available in its original branch for a later reviewed retry.
- JavaScript formatting PR #189 is independently approved and all nine checks passed, but remains unmerged while publishing recovery is verified. Wave 3 implementation remains queued; read-only preparation is complete. Counter deployment/disclosure and design-note implementation gates remain unchanged.
- Required revert PR #191 is now merged as `8cf6add6`; recovery Pages is pending. PR #189 normally merged this recovered main, preserves Python source/configuration exactly as main, and retains all three historical formatting SHAs. No Python formatting was reintroduced. All 78 JavaScript formatting files remain byte-identical to the independently approved head; only metadata conflict resolution was needed.

## Historical PR #190 validation (reverted by PR #191)

- Formatted 166 tracked Python files across backend, growth and scripts with pinned Ruff 0.17.4. Four docstring values that Ruff would normalize were preserved verbatim; all Python ASTs, including string values, match the corresponding pre-format tree. No generated output, golden manifest/archive, public text, or service configuration changes.
- Two pure-format commits are recorded by full SHA in `.git-blame-ignore-revs`; metadata follows them. Current main was integrated normally, including the newly merged directory checker and its test. No history rewrite.
- Backend: 1,480 passed, two known optional-dependency skips. Golden: two tests passed, all 695 files unchanged. Packaging: two passed. Ruff correctness checks passed. Integrated directory/generator/golden tests and Linux CI run before merge.
- Retained PRs now merged under Bruce's explicit authorization: #177 `aef83ea3` (Pages 42884666843 green), #178 `4445cbb5` (Pages 42884967351 green), #175 `f4504cb1` (Pages 42886167129 green), #165 `824b8a42` (Pages 42886670663 green). Each had independent review and all nine checks green. Product tracker #186 merged as `ad3fca40`, Pages 42885443353 green.
- Worker counter code is merged but awaits approved/published disclosure and operator deployment. Design-note merges do not enable email/payment implementation or resolve the notes' remaining choices. Product/Growth Refactor was notified directly and resumed coordinated work.
- Python formatting PR #190 originally merged as `f38bd93e` after independent review and all CI passed; deployment subsequently timed out and #191 reverted it. Its two pure-format SHAs remain historical entries in `.git-blame-ignore-revs` alongside the JavaScript SHA; a later retry will add its own new SHA.

### WP-0.3 JavaScript mechanical formatting (2026-11-10)

- Current authorization: Bruce lifted the formatting timing and empty-queue gates; the historical waiting statements above no longer block this package. Product-owned files remain excluded. Implementation is isolated in `InternScout-refactor-js-format`, based on main `0fe4eca3`.
- Pure formatting commit: `403d4c9490a72f185f7894a06b28cce9c28b0ab1`, recorded in `.git-blame-ignore-revs` in the following metadata commit. Prettier 3.9.10 with the existing configuration changed 78 files: 46 extension files, 14 site tests, and 18 worker files. No package scripts, dependencies, workflows, HTML, CSS, public JavaScript, fixtures, or golden files changed.
- Worker scope is explicit: `src/{auth,clock,demand,gemini,http,leads,profile,session,social-video}.js`, their existing matching unit tests (there is no separate http test), and `vitest.config.js`. All other worker files remain untouched, including checkout, orders, billing, limits, placements, mail, referral, financial/shared tests, scripts, and Workers runtime tests. PR #175 owns `visits.js` and its test; neither was formatted.
- Extension scope preserves `.prettierignore` exclusions, including the guard and all 14 protected safety tests. Generated `lib/pdf_fonts.js` and cost/pricing meter `lib/usage.js` were additionally excluded. Site-test scope excludes buy, employer, placement, and count tests. Product's reserved `tests/site/quick-profile.test.mjs` and `distribution-links.test.mjs` are excluded; neither existed on the starting main. Root tooling and growth files were outside this formatting pass.
- Measured layout obstacle: the first pass produced eight failing extension assertions in auth_offer, batch_focus, ext_design, held_install, and setup_email. Restoring formatter changes in `extension/background/index.js`, `extension/background/agent.js`, `extension/onboarding/onboarding.js`, and `extension/sidepanel/sidepanel.js` restored all 345 tests. No assertion was changed; protected tests stayed byte-identical. These four implementation files remain deferred.
- Mechanical proof: parsed before/after with installed Espree; every changed file has equal normalized AST, including literal values, template raw/cooked values, and regex patterns/flags. Normalization ignores source positions and literal spelling, and equates quoted versus identifier noncomputed property keys. Final formatted files pass the configured Prettier check. The first pass changed 86 working files; exclusions and line-ending-only files reduced the committed diff to 78.
- Validation on Python 3.12 / Node 22: worker unit **333 passed**, extension **345 passed**, site **257 passed**, Workers runtime **11 passed** across five files, packaging **2 passed**, JavaScript lint **0 errors / 0 warnings**. Golden build matched **695 files**, with no refresh. Worker type reporting completed with **914 errors**, report-only existing debt; no type fixes were mixed in. `git diff --check` passed. Local diagnostic reporting suppressed assertion source values; ignored local logs were not committed or uploaded.
- Deferred question under section 9 / Q3: may a later explicitly authorized pass format checkout, billing/recovery/refund modules and their financial tests? They remain untouched here. Public `docs/js` formatting also remains deferred until its exact-output baseline treatment is agreed. Resolving source-layout assertions would be separate test work; this PR preserves them.
- Worker deployment remains operator-owned. If merged, record this formatting-only PR in the waiting-for-deploy ledger; no deployment is required to change behavior, and none was performed.
- Integration: main `ad3fca40` was merged normally before opening PR #189; its delta contains only the approved product design and status notes. No source or golden baseline changed during integration. Independent review and final CI remain pending.
- Final integration: main `824b8a42` (retained PRs #165 and #175) was merged normally. Only STATUS required conflict resolution; upstream authorization, both retained-PR evidence sections, and the product ledger were preserved. `visits.js` and its tests remain exactly upstream, and all 78 formatted files plus the pure-format SHA are unchanged. Node 22 worker rerun: **336 passed**; golden rerun: **695 files matched**, no refresh. Independent delta review and final CI are pending.
- Python integration: normally merged main `f38bd93e` after PR #190. Conflicts were limited to STATUS and the blame-ignore file; all three full formatting SHAs and both languages' evidence are retained. The 78 JavaScript files remain identical to the independently approved formatting head, and product ledger/visits files remain exactly upstream. No JavaScript suite was repeated for this metadata/Python-only integration; final CI and independent delta review remain required.

## Python formatting retry preparation

- Recovery PR #191 merged as `8cf6add6` after independent exact-tree review and all nine checks passed; its Pages run must be green before any next main merge.
- Prepared a new retry using only the 166 previously reviewed Python files. Verified the recovered baseline source exactly matches pre-format main before reapplying, and the resulting files exactly match approved PR #190. The new pure-format SHA is recorded in blame-ignore metadata afterward. No workflow, public asset, golden fixture, or runtime behavior changes.
- Prior full backend/golden/packaging/integrated-directory validations remain recorded in PR #190; CI reruns every suite on this retry. Independent review is required. No manual publishing workflow is dispatched, and deployment/release restrictions remain in force.
- All four retained PRs (#165, #175, #177, #178) remain merged with green Pages. The counter worker changes await approved disclosure and operator deployment; design-note implementation choices remain gated.

- Recovery Pages run 42890454209 passed all jobs. JavaScript formatting #189 merged as `da5bc492` after independent final review and all nine checks passed; its Pages run must pass before this retry merges. Integrated its exact source and all tracker evidence by normal merge.


## WP-1.1 unused local server and review archive

- Started from clean main `182c02ce` after the lead authorized Wave 3. Re-read current instructions and trackers; product PRs #187, #188 and #193 claim different files. PR #192 is merged; its Pages result remains a lead-owned gate before the next merge.
- Rechecked the entire tracked repository, including workflows and data, while excluding protected MuseWork. Only `run.sh` launches `internscout.api`; the legacy frontend is its only client. FastAPI imports occur only in that module, and uvicorn only in the launcher and dependency pin. Removed those three approved unused files and the two pins. Retained DB/models/schemas and the classification vocabulary mentioning FastAPI. README and CONTRIBUTING already document static serving and need no edit.
- Moved 24 review files under `notes/reviews/`, preserving their contents except one relative worker-document link and one documented audit-output path. Repaired four external review-path references. Historical refactor hand-offs retain their original evidence paths. No public site output, privacy, pricing, or data collection changes.
- Validation: full backend suite **1,484 passed, two known optional-dependency skips** in 198.20s; standalone golden build matched all **695 files** without refresh; Ruff correctness checks passed. The move-content audit verified all 24 files against Git blobs, allowing only the two exact path substitutions; all three relative Markdown links and four external review references resolve. DB/models/schemas remain byte-identical. Remaining legacy-name search matches are historical notes and FastAPI classification vocabulary. `git diff --check` passed. Final CI and independent review remain required.

- Final integration: normally merged recovered main `e009644f`, including automated data refresh `79e85` and the product recovery ledger. Approved deletions, dependency removals, archive moves and six path repairs are unchanged. Current data and product files match recovered main exactly. Product #197 recovery Pages run 42896131695 and its exact-commit backend check are verified green. Fresh final-head CI/review remain required before lead merge.
