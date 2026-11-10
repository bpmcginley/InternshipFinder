# InternScout refactor: hand-off for a Codex session with many agents

Written 2026-11-10 by Claude for Bruce McGinley. Based on `main` at `0607a74` (2026-11-09).
Background and evidence: `notes/refactor/ANALYSIS.md`. This file stands alone; read the other only if you want the reasoning.

## 0. How to use this file

You are the lead session. You plan, assign work packages (WP) to worker agents, review their PRs, and keep the status file current. Workers each take one WP in their own git worktree and branch.

This file lives at `notes/refactor/HANDOFF.md`. Your first PR adds a tracker beside it:

- `notes/refactor/STATUS.md` (one row per WP: owner, branch, PR link, state, notes)

Update `STATUS.md` in every PR. It is the shared memory between agents and sessions. Do not store chat transcripts or private reasoning in it.

## 1. Goal

Make the codebase easier and safer to change, with **no change in behaviour** unless a WP says so. The live site, search pages, checkout and the extension must keep working exactly as they do now.

## 2. Decisions Bruce has made (2026-11-10)

1. Scope is all areas: backend, site, extension, worker, growth, CI.
2. Take the internal notes off the public site. Those URLs will return 404. Approved.
3. Move listing data off `main` to a separate `data` branch.
4. Jinja2 is allowed as a new backend dependency for page templates.
5. Remove `frontend/`, `run.sh` and `backend/internscout/api.py` if nothing uses them. **Keep `MuseWork.md`. Do not edit, move or delete it.**
6. Execution is by Codex with many agents, from this hand-off.
7. Codex starts straight away, with no check-in first, and the lead session may merge its own refactor PRs under the conditions in section 3. Production deploys and the items in section 8 stay with Bruce.

## 3. Hard rules

- **Never force-push.** Not on any branch. Say this in every worker prompt.
- **Merging.** Workers never merge. The lead session may merge a refactor PR when all of these hold: every CI check is green; a second agent has reviewed it for hidden behaviour change; the golden test is unchanged, or every changed output file is explained in the PR; and it is not on the list in section 8. The repo does not allow GitHub auto-merge, so merge by hand, one PR at a time.
- **Merging to `main` publishes the site.** After any merge that touches `docs/`, `backend/` or `.github/workflows/pages.yml`, wait for the Pages run and confirm it is green before merging the next PR. If it fails, open a revert PR at once and merge it.
- **Do not deploy.** No `wrangler deploy`, no `wrangler d1 execute --remote`, no manual workflow runs that publish, send email, post to social accounts, or publish the extension.
- **No secrets** in code, logs, PRs, or `STATUS.md`. Do not print tokens. Do not write private service identifiers (database id, Stripe account id, Cloudflare account id, Meta app id) anywhere new.
- No account creation, no passwords, no payments.
- **Do not rewrite git history.** No rebase of shared branches, no filter-repo, no history cleanup of old data commits.
- **Do not collect new user data or change the privacy policy.** Ask Bruce first.
- Do not touch other checkouts on this machine or another agent's uncommitted work. Work only in worktrees you create.
- Any text a user can see (site, extension, emails): plain English, no em dashes, no emoji, honest facts. Refactor PRs should not change user-visible text at all.
- If a WP cannot be done without changing behaviour, stop that WP and write the question in `STATUS.md` for Bruce. Do not guess. Carry on with the other WPs.

## 4. Running many agents safely

- **One WP, one agent, one worktree, one branch, one PR.** Branch names: `refactor/<wp-id>-<short-name>`.
- **File ownership.** Each WP lists the paths it owns. Two WPs running at once must not own the same file. If a worker needs a file outside its list, it asks the lead.
- **Waves.** Section 7 groups WPs into waves. WPs inside a wave can run in parallel. Start a wave only when the PRs it depends on are merged.
- **Keep PRs small.** Target under 600 changed lines of real change. Pure file moves can be larger but must contain no logic change; say so in the PR text.
- **Old import paths keep working** until WP-6.2. When code moves, leave a thin re-export at the old location.
- **Rebase by merge.** To pick up `main`, merge `main` into your branch. Never force-push after a rebase.
- **PR text** must have: WP id, what moved or changed, "behaviour change: none" or the exact change, test output summary, golden result (once WP-0.2 exists).
- **Review.** A second agent reviews each PR for hidden behaviour change before the lead merges it.
- Other agents (Claude and others) also open PRs in this repo. Check `gh pr list` before starting each wave and avoid files with open PRs.

## 5. Verification (run what applies, paste the summary in the PR)

```
cd backend && python -m pytest tests/ -q
cd worker && node --test test/
cd worker && npm ci && npm run test:workers
node --test extension/test/*.test.mjs
node --test tests/site/*.test.mjs
python -m unittest discover -s scripts -p 'test_release_extension.py'
```

Python 3.12, Node 22. Check the workflow files for the exact current commands before relying on these. After WP-0.2: also the golden build test. After WP-0.3 and 0.4: lint and type checks.

## 6. Work packages

Facts below were measured on the snapshot. Items marked **verify** were inferred: confirm before acting.

### Phase 0: safety net

**WP-0.1 Stop publishing internal notes** (behaviour change approved)
- Why: `pages.yml` runs `cp -r docs _site`, so `docs/coverage-research/` and `docs/product-review/` are live on the site (confirmed 200 on 2026-11-10).
- Do: `git mv` both folders to `notes/coverage-research/` and `notes/product-review/`. Update references in `AGENTS.md`, `backend/internscout/sources/workday.py`, `backend/tests/test_scan_completeness.py`, `reviews/2026-10-16-post-release/STATUS.md`. Add a step in `pages.yml` after the site is built that lists `_site` and fails if any path falls outside an allow list kept in one small file.
- Owns: the two folders, `pages.yml` (allow-list step only), the four referencing files.
- Accept: build passes; the allow-list check fails when a stray `.md` is added under `docs/`; no `.md` notes in `_site`.
- This is the first PR after the status tracker PR. It can go ahead of everything else.

**WP-0.2 Golden build test** (blocks Phases 2, 3, 5, 6)
- Why: every later refactor must prove the built site is byte-for-byte the same.
- Do: commit a small fixed sample of listing data under `backend/tests/fixtures/golden/` (a few hundred public listings covering every page type: field, employer, near-metro, pay, numbers, digest, placements). Add a test that runs the full site build (the same entry points `pages.yml` uses: `export_static`, `seo_pages`, `site_links`, feeds, widget data) into a temp folder with a pinned clock, then compares a manifest of `sha256` per output file to `backend/tests/fixtures/golden/manifest.json`. Add one command to refresh the manifest on purpose. On failure, print which files changed and a short diff of the first few.
- Watch for: any use of the current date or time, random order, set ordering, and network calls in the build. Pin or inject them. If pinning needs a code change, keep it minimal and behaviour-neutral in production.
- Owns: new files under `backend/tests/`, plus the smallest possible clock hook.
- Accept: test passes twice in a row and on CI; changing one character of any template makes it fail.

**WP-0.3 Lint and format**
- Do: add root `pyproject.toml` with ruff lint and format config, and an eslint flat config for `worker/`, `extension/` (exclude `extension/vendor/`), `docs/js/`, `tests/`. Start with a rule set the code already passes or nearly passes. Add a CI job. Then one mechanical formatting PR per language with nothing else in it, and add its commit to `.git-blame-ignore-revs`.
- Timing: the formatting PRs touch most files. The lead runs them when `gh pr list` shows no open PRs from anyone, merges them quickly, and no other WP runs until they are merged.
- Accept: CI lint job green; formatting PRs show test results identical to before.

**WP-0.4 Type checks without a build step**
- Do: pyright in basic mode for `backend/internscout` and `growth`. A `jsconfig.json` with `checkJs` for `worker/src` first. Report-only in CI at first; record the starting error counts in `STATUS.md`; make it required once at zero for the worker.
- Extension and site JS come later (after Phase 5).

**WP-0.5 Coverage reports** (report only): `pytest-cov` for Python, `c8` for the Node suites, uploaded as CI artifacts. No thresholds yet.

**WP-0.6 Shared CI setup**
- Do: composite actions under `.github/actions/` for "Python 3.12 + install" and "Node 22". Use them in all 12 workflows. Remove `# was:` comment lines from workflows.
- Care: do not change triggers, schedules, permissions, secrets usage or concurrency groups. Diff each workflow's effective steps before and after.
- Owns: `.github/` except the lines WP-0.1 adds.

### Phase 1: clear the ground

**WP-1.1 Remove leftovers**
- Measured: `api.py` is referenced only by `run.sh`; `frontend/index.html` only by `api.py`. `db.py` and `models.py` are used by `pipeline.py` and `export_static.py`: **keep them**.
- Do: re-check with a search across the whole repo including workflows and docs. Remove `frontend/`, `run.sh`, `backend/internscout/api.py`. Drop `fastapi` and `uvicorn` from `backend/requirements.txt` if nothing else imports them. Update `README.md` and `CONTRIBUTING.md` if they mention the local server. Move `reviews/` to `notes/reviews/`. Leave `MuseWork.md` alone.

**WP-1.2 Python packaging**
- Do: declare `internscout` and `growth` as installable packages in the root `pyproject.toml` (editable install in CI). Move the tests for `growth/` (21 files in `backend/tests` reference it, **verify** which are purely growth tests) to `growth/tests/`. Keep `python -m internscout.<module>` and `python growth/<script>.py` invocations in workflows working.

**WP-1.3 Docs index**
- Do: `notes/README.md` linking every runbook by topic (12 in `growth/`, 7 in `worker/`, 4 in the root). Refresh `AGENTS.md`: current rules from section 3, where state lives, drop the stale October model notes only if Bruce agrees (ask in `STATUS.md`).

**WP-1.4 Logging**
- Measured: 178 `print()` calls, no `logging` use, 19 broad `except` blocks in `backend/internscout` and `growth`.
- Do: one small setup helper; replace `print()` with logger calls. Default console output must be the same text as today, because workflow logs and some tests read it (**verify** which tests assert on stdout). Add an opt-in JSON mode by environment variable. For each broad `except`, log the exception; do not change what is caught.
- Split by area into several PRs: sources, pipeline and export, page build, growth.

**WP-1.5 Automatic cache versions**
- Measured: `core.js` and `app.js` carry a hand-written `?v=`; `placements.js`, `offer.js` and four of five `count.js` tags carry none.
- Do: in the Pages build, stamp each local script and stylesheet URL with a short content hash. Remove the hand-written strings from source HTML. This changes built HTML, so update the golden manifest in the same PR and say so.

### Phase 2: single sources of truth

**WP-2.1 Vocabularies.** Majors, fields, sectors and states are assigned in about 10 Python modules, in `extension/onboarding/onboarding.js` and in `docs/js/core.js` (**verify** which are true duplicates and which are derived). First PR: a written inventory in `notes/refactor/vocab-inventory.md`, no code. Then one data file owned by the backend, a generator that writes the JS copies, and a CI check that fails on a stale copy. Any real difference between copies found on the way is a question for Bruce, not something to "fix" silently.

**WP-2.2 Design tokens.** 57 CSS variable names are shared by `docs/index.html`, `docs/employers/index.html` and the Python page generator, each with its own copy. Make one `tokens.css` as the source. Hand-written pages and the generator read from it. Keep CSS inlined in the built output if that is how it ships today (first-paint speed); the single source is in the repo, the inlining happens at build. Built output should stay identical; if not, explain every difference.

**WP-2.3 Worker API contract.** Turn `worker/API.md` (672 lines of prose) into a route table in code (path, method, auth level, request and response shape) and generate the markdown from it. Tests: every route the worker serves is in the table; every worker path the extension and site call is in the table.

**WP-2.4 Config.** The worker base URL is hard-coded in 7 files. One config module per area, each generated from one value.

### Phase 3: split `backend/internscout/seo_pages.py`

Measured: 4,245 lines, 149 functions, 128 module-level constants, a 599-line `build()` that calls 111 functions, 10 function-level imports that dodge cycles. Imported by 9 backend modules and 9 growth scripts. Test file is 2,382 lines.

Target (keep `seo_pages.py` as a thin re-export until WP-6.2):

```
internscout/site/
  catalog.py     which pages exist and which listings each shows
  rules.py       index or noindex, duplicates, thresholds, sitemap membership
  facts.py       employer facts, pay, fit, FAQ answers (data only, no HTML)
  render/        layout.py listing.py employer.py field.py near.py numbers.py digest.py
  assets.py      CSS and tokens
  sitemap.py  feeds.py  llms.py
  build.py       orchestrator: an ordered list of named steps
```

This phase is **mostly serial** because every step edits the same file. One agent owns `seo_pages.py` at a time. Other agents can split `test_seo_pages.py` to follow, one step behind.

- **WP-3.1** Move constants and pure helpers. No logic change.
- **WP-3.2** Move sitemap, feeds and `llms` output.
- **WP-3.3** For each page family (near, employer, field, pay, numbers, digest, listing), split "choose the data" from "draw the HTML": a plain data object, then a render function that takes only that object. One PR per family.
- **WP-3.4** Break `build()` into about 10 named steps with explicit inputs and outputs. Remove the function-level imports.
- **WP-3.5** Point `growth/*` and the other backend modules at the new modules.
- **WP-3.6** (optional, last) Move HTML from f-strings to Jinja2 templates with auto-escaping on. Only if the golden test stays identical. Check escaping page by page: f-strings escape by hand today, so double-escaping is the main risk. If any family cannot be made identical, leave it as f-strings and note why.

Every PR in this phase: golden test unchanged, no manifest update allowed.

### Phase 4: worker

**WP-4.1 Migrations.** Today `npm run deploy` runs `schema.sql` (45 tables, all one file). `campaign-report-schema.sql` and `order-mail-schema.sql` are not in the deploy script (**verify** how they were applied). Prepare `wrangler d1 migrations`: current schema as `0001`, the two extra files as `0002` and `0003`. Add a test that builds a local D1 from migrations only and compares it with a database built from the current files. Write `worker/MIGRATIONS.md` with the exact steps Bruce must run to mark `0001` to `0003` as already applied in production. **Do not run anything against the remote database. Do not change the deploy script until Bruce has done that step.**

**WP-4.2 Split `orders.js`** (1,377 lines, 39 exports) into `orders/checkout.js`, `capacity.js`, `refunds.js`, `outbox.js`, `admin.js`, `pilot.js` (**verify** the natural seams first). `orders.js` re-exports. File moves only. Split `orders.test.js` the same way. The Workers-runtime suite must pass unchanged.

**WP-4.3 Route table.** Replace the long `route()` in `index.js` with a table built from WP-2.3 (path, method, auth level, limiter, handler). Auth and limits become wrappers applied by the table. Response bodies, status codes, headers and CORS must be identical: add a test that records every route's response for a fixed set of requests before the change and compares after.

**WP-4.4 Test runner tidy.** Document which suite is for what (`node --test` for pure logic, vitest for D1 and the Workers runtime). Move misplaced tests.

### Phase 5: site and extension JavaScript

**WP-5.1 Site scripts to native ES modules**, still no build step. Split `core.js` (1,279 lines) and `app.js` (2,067) into modules; keep a `window.IS` shim while anything still reads it (the extension bridge does, **verify**). Tests move from the `vm` sandbox to real imports. Before starting, the lead asks Bruce to confirm browser support is acceptable (module scripts need browsers from about 2018 on). `buy.js` (743 lines) is the checkout flow: do it last, alone, with its 687-line test file passing unchanged.

**WP-5.2 Extension.** Split `background/agent.js` (1,141) and `onboarding/onboarding.js` (968). **Do not change `agent/guard.js` or its tests**: it is the safety layer for Auto-Apply. The reproducible packaging test must still pass. No version bump, no store release.

**WP-5.3 Shared pure code** (profile shape, scoring, listing ids) in one `shared/` folder, copied into the extension at package time, with a staleness check.

### Phase 6: data and delivery

**WP-6.1 Listing data to a `data` branch.** The ingest job commits `docs/data` (about 65 MB, 141 files) plus `backend/data/ats_registry.json`, `dropped_boards.json` and the geocache to `main` every 6 hours (546 of 1,197 commits). `pages.yml`, `digest.yml`, `metrics.yml` and about 14 code files read `docs/data`. Steps, one PR each:
1. One `DATA_DIR` setting used by every reader and writer, default `docs/data`. No behaviour change.
2. Tests that read real data files switch to fixtures (**verify** which do).
3. Workflows check out a second copy of the repo at the `data` branch into a side folder and point `DATA_DIR` at it, falling back to `main` when the branch does not exist. Readers first (Pages, digest, metrics).
4. Create the `data` branch from current `main` data with a normal push. Bruce sets any branch rules.
5. Ingest writes to the `data` branch. Keep the "Pages follows the ingest run" trigger working.
6. After 7 days of clean ingest and Pages runs: remove the data files from `main` in one PR and add them to `.gitignore`. Add a script that fetches the `data` branch into `docs/data` for local work.
- Rollback at any step is a revert of that step's PR. History on `main` is never rewritten.

**WP-6.2 Remove compatibility shims** once a repo-wide search shows no imports of old paths.

**WP-6.3 Ingest timing.** Using the logs from WP-1.4, report time per source for a normal run. Report only; propose changes in `STATUS.md`.

## 7. Waves

| Wave | Work packages | Notes |
|---|---|---|
| 0 | status tracker PR, then WP-0.1 | Do first |
| 1 | WP-0.2, WP-0.4, WP-0.5, WP-0.6 | Parallel. Different files |
| 2 | WP-0.3 | Alone. Nothing else open while formatting PRs are up |
| 3 | WP-1.1, WP-1.2, WP-1.3, WP-1.5, WP-2.3, WP-4.1, WP-4.4 | Parallel |
| 4 | WP-1.4 (several agents by area), WP-2.1 inventory, WP-2.4, WP-4.2 | Parallel |
| 5 | WP-3.1 to WP-3.5 in order (one owner of `seo_pages.py`), WP-4.3, WP-5.2 alongside | Phase 3 is serial inside |
| 6 | WP-2.1 code, WP-2.2, WP-5.1, WP-5.3, WP-6.1 steps 1 to 3 | WP-2.2 after Phase 3 so the CSS has one home |
| 7 | WP-3.6, WP-6.1 steps 4 to 6, WP-6.2, WP-6.3 | WP-6.1 step 6 waits 7 days |

Each wave ends with all its PRs merged and `STATUS.md` updated. Do not stack PRs on unmerged PRs across waves.

## 8. Things only Bruce does

- Merging any PR that changes behaviour beyond what section 2 already approves (WP-0.1 and WP-1.5 are approved).
- Any production deploy: worker, database, extension release. Worker code merged to `main` goes live only when Bruce deploys, so list every merged worker PR in `STATUS.md` under "waiting for deploy".
- Marking database migrations as applied in production, and the deploy script change that follows (WP-4.1).
- Branch rules and repo settings.
- Any change to user-visible text, privacy policy, pricing or data collection.

## 9. When to stop and ask

Stop the affected WP, write the question in `STATUS.md`, and keep working on WPs that do not depend on the answer.

- The golden test changes and you cannot explain every changed file.
- A "leftover" turns out to be used.
- Two copies of a vocabulary or token differ in a way that looks like a bug.
- A workflow change would alter a trigger, schedule, secret or permission.
- Anything touching checkout, refunds, billing recovery or the Auto-Apply guard beyond file moves.
- Tests fail on `main` before your change. Report it; do not fix it inside a refactor PR.

## 10. Not checked when this was written

- No test suite was run and no coverage was measured.
- Large files were measured and skimmed, not read line by line.
- The contents of the two notes folders were not read.
- Items marked **verify** above.
