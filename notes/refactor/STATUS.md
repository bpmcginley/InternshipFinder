# InternScout refactor status

Updated: 2026-11-10. Lead: Codex lead session. Instructions: [HANDOFF.md](HANDOFF.md); background: [ANALYSIS.md](ANALYSIS.md). The current user instructions and HANDOFF decisions supersede historical proposals in ANALYSIS.

## Current position

- Hand-offs found on `origin/refactor/handoff-docs` and read in full before the audit. [PR #167](https://github.com/bpmcginley/InternshipFinder/pull/167) merged as `00cf10e0` after independent review and all checks passed. Its only changes were these two internal documents.
- Wave 0: status tracker merged; WP-0.1 implementation and local validation are complete, awaiting independent review and green PR checks. All six baseline suites passed, with two documented local backend skips. Independent full-file audit results are recorded below.
- Baseline is clean main `57202cae`, before refactor changes. The original checkout contains unrelated uncommitted work and is untouched. Implementation uses separate, explicitly owned worktrees and branches.
- External [PR #165](https://github.com/bpmcginley/InternshipFinder/pull/165) touches directory monitoring, growth documentation, and `growth/every_major_list.py`. Avoid those paths while it remains open. Recheck open PRs before every wave. Mechanical formatting waits until no other PR is open; this does not authorize closing or merging someone else's PR.
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
| 0 | WP-0.1 Internal notes | read_backend | `refactor/wp-0.1-internal-notes` | [#169](https://github.com/bpmcginley/InternshipFinder/pull/169) | In review | Local validation passed; independent review and green CI before lead merges. |
| 1 | WP-0.2 Golden build | Unassigned | - | - | Queued | Full actual build, fixed data/clock, two reproducible passes, deliberate mutation rejection. |
| 1 | WP-0.4 Type checks | Unassigned | - | - | Queued | Report-only Python/worker checks; record initial counts. |
| 1 | WP-0.5 Coverage | Unassigned | - | - | Queued | Report-only Python and Node artifacts; no thresholds. |
| 1 | WP-0.6 Shared CI setup | Unassigned | - | - | Queued | Preserve all effective workflow behavior; coordinate CI file ownership. |
| 2 | WP-0.3 Lint configuration | Unassigned | - | - | Queued | Minimal passing rules and CI; avoid type/coverage config conflicts. |
| 2 | WP-0.3 Python formatting | Unassigned | - | - | Waiting for quiet window | No other PRs open or packages running; mechanical-only PR and blame-ignore entry. |
| 2 | WP-0.3 JavaScript formatting | Unassigned | - | - | Waiting for quiet window | Same quiet-window requirement; separate mechanical PR. |
| 3 | WP-1.1 Leftovers | Unassigned | - | - | Queued | Verify all references before removal; preserve DB/models and MuseWork. |
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
- Golden output comparison is not yet available: WP-0.2 follows this package. Public source assets and generator code are unchanged; the planned output difference is removal of the two internal-note trees.

## Questions and external gates

| ID | Affected scope | Question / gate | Current handling |
|---|---|---|---|
| Q1 | WP-1.3 model notes only | May the stale October model-choice notes be removed from AGENTS.md? HANDOFF explicitly reserves this decision. | Preserve them; docs index/current rules can proceed. |
| Q2 | WP-5.1 | Is native ES-module browser support acceptable? HANDOFF requires confirmation before implementation. | Record question now; independent work continues. |
| Q3 | WP-4.3 financial routes; WP-5.1 buy | May checkout/refund routing move beyond file moves into new auth/limiter wrappers or module integration? Section 9 requires a decision for that scope. | Contract inventory and characterization may proceed; financial behavior restructuring remains paused. |
| Q4 | WP-2.1 state-label normalization only | State maps use different DC display labels. Are these intentional presentation differences? | Inventory and generation may preserve distinct representations; no silent label unification or user-visible text change. |
| G1 | WP-4.1 adoption | Bruce verifies actual production schema and marks the baseline migration applied; deployment-script change follows only afterward. | Prepare and test locally; no production commands. |
| G2 | WP-0.3 formatting | No other PR may remain open during mechanical formatting. External PR #165 is currently open. | Wait for quiet window; do not interfere with unrelated PR. |
| G3 | WP-6.1.6 | Seven days of clean ingest and Pages after data-writer cutover. | No cutover yet; observation clock has not started. |

## Waiting for deploy

None. No worker refactor PR has merged, and no production action has been taken.

## Merge and publication ledger

| PR / package | Commit | Review / CI | Pages | Result |
|---|---|---|---|---|
| [#167 Hand-offs](https://github.com/bpmcginley/InternshipFinder/pull/167) | `00cf10e0` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42859546750) | Merged; documentation only. |
| [#168 Status tracker](https://github.com/bpmcginley/InternshipFinder/pull/168) | `64fd6400` | Independent agent review; all checks green | [Green run](https://github.com/bpmcginley/InternshipFinder/actions/runs/42861453089) | Merged; documentation only. |

## Next update

Finish WP-0.1 validation and independent review, merge under the rules above, then verify Pages before the next merge. Continue the waves without routine approval pauses; preserve all explicit package-specific boundaries.
