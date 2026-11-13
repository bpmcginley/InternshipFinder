# InternScout: codebase analysis and refactor plan

Date: 2026-11-10. Based on `main` at `0607a74` (2026-11-09), read from a snapshot. Nothing in the repo, the site, the worker or any account was changed. This is a plan only.

The questions in section 9 were answered on 2026-11-10. The answers are in `notes/refactor/HANDOFF.md`, section 2.

## 1. What I understood you want

- A full look at the project and code, and a plan to refactor it. Planning only for now.
- Deep ideas for improvement, not just tidying.
- Spend tokens carefully.

Assumptions (correct me):

- "The project" is InternScout (`bpmcginley/InternshipFinder`), all areas: site, extension, worker, backend, growth scripts, CI.
- Behaviour must not change during the refactor. Search rankings, checkout and the extension are live.
- Several agents (Claude, Codex, others) work in the repo in parallel, so changes must land as small PRs that do not block each other.

How I measured: file and function sizes, imports, workflows and configs across the whole tree. I read the structure of the largest files, not every line. Items marked "verify" were inferred and need a closer read before acting.

## 2. The codebase today

| Area | Size | What it is |
|---|---|---|
| `backend/internscout` | 17,155 lines, 66 files | Python: fetch listings (25 source adapters), normalize, classify, export, build landing pages |
| `backend/tests` | 16,053 lines, 64 files, 968 tests | pytest; also holds the tests for `growth/` |
| `worker/src` | 5,473 lines, 22 files | Cloudflare Worker: auth, AI limits, billing, orders, placements, visits |
| `worker/test` | 6,149 lines | `node --test` plus a vitest Workers-runtime suite |
| `extension` | about 9,000 lines + 5,840 test lines | MV3 extension 0.5.9: onboarding, Auto-Apply agent, side panel |
| `docs/js` + HTML | 4,690 lines JS, 5 hand-written pages | Dashboard (React from CDN, no build step), buy flow |
| `growth` | 5,958 lines, 21 scripts, 12 runbooks | Digest, social, metrics, campaign, outreach |
| `.github/workflows` | 12 workflows | Ingest every 6 h, metrics hourly, catch-up twice an hour, Pages, digest, social, release |
| `docs/data` | 64.9 MB, 141 JSON files | Listing data, committed to `main` by the ingest job |

Strengths worth keeping:

- Tests are strong: test code is about as large as product code in every area.
- The worker is already split into small ES modules with injected clock, fetch and config.
- The site has no `innerHTML` use and pins CDN scripts with integrity hashes.
- 84% of backend functions have type hints. Only 15 TODO/FIXME notes in the whole tree.
- Dependencies are tiny. No build step means nothing to break at deploy.

## 3. Findings, most important first

### A. Things to fix regardless of any refactor

1. **Internal notes are public.** `pages.yml` runs `cp -r docs _site`, so `docs/coverage-research/` (18 files) and `docs/product-review/` (3 files) are served on the live site. I checked: `internscout.org/coverage-research/README.md` and `internscout.org/product-review/CONTEXT.md` both return 200. They hold strategy and review notes, not secrets as far as the file names show (verify contents). Fix: move both folders out of `docs/`, and add a CI check that only an allowed list of paths is published.
2. **Two database schema files are not part of deploy.** `npm run deploy` applies `schema.sql` only. `campaign-report-schema.sql` and `order-mail-schema.sql` are applied by hand (verify). A fresh database or a recovery would miss them.
3. **Script cache versions are set by hand and are uneven.** `core.js` and `app.js` carry `?v=20261018-digest`; `placements.js`, `offer.js` and four of five `count.js` tags carry none. A returning visitor can run new `app.js` with an old `placements.js`.
4. **No linter, formatter or type check anywhere.** No `pyproject.toml`, no ruff, no eslint, no editorconfig. With several agents writing code, style and dead code drift with nothing to catch them.

### B. Structure problems

5. **`seo_pages.py` is the centre of gravity: 4,245 lines, 149 functions, 128 module-level constants.**
   - `build()` is one 599-line function that calls 111 other functions.
   - It mixes five jobs: page data selection, HTML rendering (133 f-string HTML lines), CSS (58 design tokens inline), sitemap and noindex rules, and `llms.txt` output.
   - 9 backend modules and 9 growth scripts import from it, and it imports some of them back with 10 function-level imports to dodge import cycles. Social cards and the weekly email depend on a module whose name says "SEO pages".
   - Its test file is 2,382 lines.
6. **Design tokens are copied in at least three places.** 57 CSS variable names are shared between `docs/index.html`, `docs/employers/index.html` and the Python generator, each with its own copy. `index.html` has a 557-line inline style block. A colour change means editing 5 HTML files and a Python file.
7. **Vocabularies are defined many times.** Majors, fields and sectors are assigned in 10 Python modules, again in `extension/onboarding/onboarding.js`, and again in `docs/js/core.js` (states, vocabularies). Verify how many are true duplicates and how many are derived views. A new field today needs edits in several languages.
8. **Site JavaScript is three big scripts sharing `window.IS`.** `app.js` 2,067 lines, `core.js` 1,279, `buy.js` 743. Tests load the source text into a `vm` sandbox, which works but hides load-order bugs and blocks normal imports.
9. **Worker hot spots.** `orders.js` is 1,377 lines with 39 exports (checkout, capacity, refunds, outbox, admin in one file). `index.js` routes inside one long `route()` function. The schema is one 690-line file with 45 tables and no migration history, so a column change has no recorded path.
10. **Extension hot spots.** `background/agent.js` 1,141 lines and `onboarding/onboarding.js` 968 lines. The extension calls the worker with no shared contract; `worker/API.md` (672 lines) is prose that can drift from both sides.
11. **Backend tests and growth tests share one folder.** 21 files in `backend/tests` test `growth/`. `growth` imports `internscout` by path, with no package definition for either.

### C. Operations and hygiene

12. **Data commits dominate history.** 546 of 1,197 commits are "data: refresh listings", each rewriting part of 65 MB of JSON on `main`. The clone is 84 MB now and grows every 6 hours. Every agent worktree, CI checkout and `git log` pays for it, and data pushes race with code merges.
13. **178 `print()` calls and no logging** in backend and growth. 19 broad `except` blocks. When an ingest run misbehaves there are no levels, no structure and no way to filter.
14. **Workflow repetition.** 12 workflows each repeat checkout, Python setup and install. Old command lines are kept as `# was:` comments inside `pages.yml` and in source. Git history already keeps those.
15. **Leftovers in the root (verify each is unused before removing):** `frontend/index.html` (164 lines), `run.sh` and `backend/internscout/api.py` (a local FastAPI server from before the static site), `MuseWork.md` (another agent's work log), `reviews/` (24 files of past reviews). `requirements.txt` pins FastAPI and uvicorn for a server that production does not run.
16. **Runbooks are scattered.** 12 in `growth/`, 7 in `worker/`, 4 in the root, plus `AGENTS.md`, a hand-off file outside the repo, and per-agent memory. `AGENTS.md` still describes an October model choice.

## 4. Three ways to do it

**Option 1: Guard rails first, then split along seams (recommended).** Add checks and a behaviour "golden" test, then carve the big files into packages one small PR at a time, keeping old import paths working until the end.
- For: no behaviour change at any step, safe with parallel agents, each PR is reviewable, you can stop after any phase and still be better off.
- Against: takes many PRs; the old and new layout coexist for a few weeks.

**Option 2: Restructure in one pass.** New folder layout, shared packages, build step for the site, all in one long branch.
- For: clean end state quickly.
- Against: one huge diff nobody can review, conflicts with every open PR from other agents, high risk to search pages and checkout. Not advised.

**Option 3: Re-platform.** Move the site to a static site generator or framework (Astro, Eleventy), TypeScript everywhere, a monorepo tool.
- For: modern tooling, components instead of f-strings.
- Against: rewrites 4,000 lines of page logic whose exact output Google has indexed, while search traffic is still recovering from the October drop. The gain is developer comfort, the risk is revenue. Revisit after traffic is stable.

Recommendation: Option 1, borrowing two ideas from Option 3 where they are cheap (a template layer, and type checking through JSDoc without a build step).

## 5. The plan (Option 1), in phases

Each phase is a set of small PRs. Each PR must pass all current tests plus the golden test from Phase 0. No PR changes behaviour unless it says so.

### Phase 0: Safety net (do first, about 6 PRs)

- **0.1 Stop publishing internal notes.** Move `docs/coverage-research` and `docs/product-review` to a top-level `notes/` folder. Update the `AGENTS.md` pointer. Add a CI step that lists `_site` and fails on any path outside an allow list. Behaviour change: those URLs become 404. Needs your OK.
- **0.2 Golden build test.** Build the whole site from a fixed, committed sample of listing data and store a hash of every output file (HTML, sitemap, feeds, shards, `llms.txt`). Any refactor PR that changes a byte of output fails unless the PR updates the hashes on purpose. This is what makes every later step safe.
- **0.3 Lint and format, check-only at first.** Add `pyproject.toml` with ruff (lint + format) and a small eslint flat config. Start with the rules the code already passes, run in CI as a required check, then widen rule by rule. Do the one-time formatting as a single mechanical PR with `.git-blame-ignore-revs`, timed when no agent has open PRs.
- **0.4 Type checking without a build.** `pyright` in basic mode for Python. For JavaScript, a `jsconfig.json` with `checkJs` on the worker first (it is already modular), then the extension.
- **0.5 Coverage numbers.** Add `pytest-cov` and `c8` reports to CI, report only. This tells us which parts of the big files are safe to move.
- **0.6 Shared CI setup.** One composite action for "checkout + Python 3.12 + install" and one for Node 22, used by all 12 workflows. Remove `# was:` lines.

### Phase 1: Clear the ground (about 5 PRs)

- **1.1 Remove or archive leftovers** after confirming nothing imports them: `frontend/`, `run.sh`, `api.py`, FastAPI and uvicorn pins, `MuseWork.md`. Move `reviews/` under `notes/`.
- **1.2 Package definitions.** One `pyproject.toml` that declares `internscout` and `growth` as packages, so imports stop relying on the working directory. Move growth tests to `growth/tests`.
- **1.3 One docs index.** A single `docs-internal/README.md` (or `notes/README.md`) that links every runbook by topic, and a refreshed `AGENTS.md` with current rules (no force-push, merge only on your say-so, where state lives).
- **1.4 Logging.** Replace `print()` in backend and growth with the `logging` module behind one small setup helper. Same text to the console by default, so workflow logs look the same, plus levels and an optional JSON mode for the ingest job.
- **1.5 Automatic cache versions.** In the Pages build, stamp every local script and style link with a short content hash. Delete the hand-written `?v=` strings.

### Phase 2: Single sources of truth (about 6 PRs)

- **2.1 Vocabularies.** One data file (for example `shared/taxonomy.json`: majors, fields, sectors, states, metro names) owned by the backend. A small generator writes the JS copies for the site and extension, and a CI check fails if a generated copy is stale.
- **2.2 Design tokens.** One `tokens.css` with the 57 shared variables. Hand-written pages link it; the Python generator reads the same file instead of carrying its own copy. Move each page's large inline style block into a real stylesheet. Check Lighthouse before and after, since inline CSS was likely chosen for first paint; if it costs speed, inline it at build time from the single source.
- **2.3 Worker API contract.** Turn `worker/API.md` into a machine-readable route table (path, method, auth, request and response shape) kept beside the router. Generate the markdown from it. Add a test that every route in the router is in the table, and a test on the extension side that every worker call it makes exists in the table.
- **2.4 Site config.** The worker base URL appears in 7 files. One config module per area, generated from one value.

### Phase 3: Split `seo_pages.py` (the largest piece, about 12 PRs)

Target layout, with `seo_pages.py` kept as a thin file that re-exports old names until Phase 6:

```
internscout/site/
  catalog.py        which pages exist and which listings each one shows
  rules.py          index or noindex, duplicates, thresholds, sitemap membership
  facts.py          employer facts, pay, fit, FAQ answers (pure data, no HTML)
  render/
    layout.py       page shell, head, structured data
    listing.py      listing cards and tables
    employer.py  field.py  near.py  numbers.py  digest.py
  assets.py         CSS and tokens
  sitemap.py  feeds.py  llms.py
  build.py          the orchestrator: a list of named steps
```

Order of work:

1. Move constants and pure helpers first (no logic change).
2. Split "decide what goes on a page" (data) from "draw the page" (HTML). Each page type gets a plain data object, then a render function that takes only that object. This is the step that lets social cards, the email digest and the widget reuse page data without importing an "SEO" module.
3. Break `build()` into a pipeline of about 10 named steps with explicit inputs and outputs. Removes the function-level imports and the import cycles.
4. Point `growth/*` and the other backend modules at the new modules.
5. Optional, last, and only if step 2 went well: move HTML from f-strings to Jinja2 templates with auto-escaping. The golden test proves the output is identical. Skip this if it adds risk for little gain.

Split `test_seo_pages.py` to follow the same module lines as each piece moves.

### Phase 4: Worker (about 8 PRs)

- **4.1 Migrations.** Adopt `wrangler d1 migrations`: the current schema becomes migration 0001 (already applied in production, so mark it applied rather than re-run), the two stray schema files become 0002 and 0003, and `npm run deploy` applies migrations. Add a CI test that builds a database from migrations alone and compares it to the expected schema. Deployment is yours to run; I prepare and test only.
- **4.2 Split `orders.js`** into `orders/checkout.js`, `capacity.js`, `refunds.js`, `outbox.js`, `admin.js`, `pilot.js`, with `orders.js` re-exporting. Tests (1,131 lines) split the same way.
- **4.3 Route table.** Replace the long `route()` body with a declarative table (path, method, auth level, limiter, handler), reusing the contract from 2.3. Auth and rate limiting become wrappers applied by the table, so a new route cannot forget them. No framework needed.
- **4.4 One test runner story.** Keep both suites but document the split: `node --test` for pure logic, vitest for anything that touches D1 or the Workers runtime. Move any test that sits in the wrong one.

### Phase 5: Site and extension JavaScript (about 10 PRs)

- **5.1 Site scripts to native ES modules** (`<script type="module">`, still no build step). Split `core.js` into `profile`, `data`, `scoring`, `session`, `bridge`; split `app.js` by screen. Keep a small `window.IS` shim while the extension bridge still expects it. Tests switch from the `vm` sandbox to real imports. Check older-browser support numbers from the visits data before starting.
- **5.2 Extension `agent.js`** into `planner`, `executor`, `takeover`, `state`; `onboarding.js` into steps plus a shared form helper. The guard module and its tests stay untouched: it is the safety layer for Auto-Apply and already well covered.
- **5.3 Shared pure code.** Profile shape, scoring and listing-id helpers live once in a `shared/` folder and are copied into the extension at package time, with the same staleness check as 2.1.

### Phase 6: Data and delivery (needs decisions from you)

- **6.1 Listing data off `main`.** Options: (a) a separate `data` branch that the ingest job pushes to and the Pages build reads; (b) Cloudflare R2, which you already have through Workers Paid; (c) keep as is. Recommended: (a). It is the smallest change, keeps history and rollbacks, stops code and data racing on `main`, and makes clones and agent worktrees light. History on `main` stays as is; never rewrite it.
- **6.2 Remove the compatibility shims** from Phases 3 to 5 once nothing imports the old names.
- **6.3 Ingest speed.** The run is about 30 minutes. With structured logs from 1.4, measure per-source time first, then decide between concurrency limits per host, conditional requests, and skipping boards that have not changed.

## 6. Ideas beyond refactoring

Higher value first. None is in the plan above unless you pick it.

1. **Build preview and diff for every PR.** The golden test can also write a short report: pages added, removed, changed, sitemap count before and after, noindex count. Posted on the PR. This would have made the October page changes (#140, #154) much easier to review.
2. **Data quality gates in ingest.** Fail or warn when a source drops by more than a set share, when open listings fall sharply, or when a field goes empty. Some of this exists (`ingest_metrics`, `scan_evidence`); make it one explicit gate with thresholds in one file.
3. **Source adapter kit.** The 25 adapters share `sources/common.py`. A small base class with recorded-response fixtures and a "new source" checklist would let an agent add a source in one PR with tests from a template.
4. **Error visibility.** Workers has built-in logs and tail; add one error-rate check to the metrics job so the Health tab of your analytics page can show worker errors, with no new vendor and no new user data.
5. **Synthetic checks after deploy.** A workflow that loads the live home page, one landing page, the buy page and the worker config endpoint after each Pages deploy and fails loudly. Read-only.
6. **Dependency updates.** Renovate or Dependabot, grouped weekly, for the handful of pins (wrangler, vitest, httpx, pydantic, GitHub Actions versions).
7. **One command per task.** A `justfile` or `Makefile`: `test`, `lint`, `build-site`, `golden`, `package-extension`. Agents and you run the same thing CI runs.
8. **Decision records.** Short dated notes (`notes/decisions/`) for choices like "no bidding", "employer index bar 10", "data on a branch". Replaces scattered `# was:` comments and saves each new agent session from re-deriving why.
9. **Performance budget in CI.** `scripts/startup_budget.py` exists; extend it to the size of the HTML, CSS and JS per page type so a refactor cannot quietly make pages heavier.
10. **Accessibility check in CI.** Run axe on the built home page, one landing page and the buy page.

## 7. Risks and how the plan handles them

| Risk | Guard |
|---|---|
| A refactor changes page output and hurts search | Golden hash test on every PR; no template move without identical output |
| Conflicts with other agents' PRs | Small PRs, old import paths kept until Phase 6, format PR timed for a quiet moment |
| Checkout or refunds break | `orders.js` split is file moves only, existing 1,131 test lines plus the Workers-runtime suite must pass unchanged |
| Database migration mistake | 0001 is marked applied, never re-run; tested on a local D1 first; you run the deploy |
| Extension release breaks Auto-Apply | Guard module untouched; reproducible packaging test already exists |
| Refactor never finishes | Every phase stands alone; Phase 0 and 1 are worth doing even if nothing else happens |

## 8. Suggested order and rough size

1. Phase 0 (safety net) and finding A1 (public notes): first.
2. Phase 1 (clear the ground).
3. Phase 3 (`seo_pages.py`): the biggest pay-off for day-to-day work.
4. Phase 2 (single sources), can overlap with Phase 3.
5. Phase 4 (worker).
6. Phase 5 (site and extension JS).
7. Phase 6 (data branch, shim removal).

Roughly 45 to 50 small PRs in total. Phases 0 and 1 are about 11 of them.

## 9. Decisions I need from you

1. Is the scope right (all areas), or should the first pass cover only some of them?
2. OK to take the internal notes off the public site (0.1)? Those URLs become 404.
3. Listing data: move to a `data` branch (recommended), move to R2, or leave on `main`?
4. Templates: allow Jinja2 as a new backend dependency for step 3.5, or keep f-strings and only split the file?
5. Leftovers: may `frontend/`, `run.sh`, `api.py` and `MuseWork.md` be removed if nothing uses them?
6. Who executes: me in small PRs for your review and merge, or a hand-off written for Codex and other agents?

## 10. What I did not check

- I did not read every file line by line. Items marked "verify" need a closer read first.
- I did not run the test suites or measure coverage.
- I did not query the database, Stripe or any analytics. The only live requests were two page fetches to confirm finding A1.
- Whether the notes in `docs/coverage-research` and `docs/product-review` contain anything sensitive: I checked that they are public, not what they say.
