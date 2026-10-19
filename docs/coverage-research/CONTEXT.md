# Coverage expansion checkpoint

Saved October 16, 2026 at the user's request to wrap up and resume later.

## Scope and checkout

Branch: `codex/expand-north-america-coverage`. Changes remain local and uncommitted. No merge, deployment, paid API/AI calls, employer submissions or production ingestion. Preserve unrelated untracked `AGENTS.md`, `docs/product-review/` and `social-setup/`.

User asked for one agent per workstream: systematic source discovery; ingestion-loss measurement; closure reliability; query/adapter expansion. All four agents finished their current implementation and stopped. The user additionally requested deliberate searches near the top 50 US metros and 500 pages named “*major* internships near *city*”. They explicitly selected the ten largest NCES bachelor's degree fields.

## Implemented and verified

- Earlier work: Canadian Oracle/Taleo/SuccessFactors admission, French stagiaire and term recognition, Workday co-op search, Scotiabank seed and geographic coverage report. See README.md and north-america-baseline.md here.
- Systematic discovery: free, robots-aware, bounded CLI, 325 jurisdiction/sector research combinations and 16 official starter hubs. **Worklist is not national coverage.** Read-only live verification found two currently unregistered boards: Nova Scotia SuccessFactors (`jobs.novascotia.ca`, 2 parsed opportunities) and Sanford Health Workday (`sanford|wd5|SanfordHealth`, 12 parsed opportunities). These are parsed observations, not validated incremental unique inventory. Registry admission and identity review remain pending. See source-discovery.md.
- Ingestion metrics: `ingest_metrics.py`; normalization rejection callback; pipeline fetched/parsed/accepted/unique/persisted counts and filter reasons; final board success/failure/blocked outcomes; export total/open/held inventory. CLI `--metrics PATH`, or defaults to `<export-dir>/ingest-report.json` during export. Source-feed failures and adapter-internal discarded candidates are still unknown. No production report generated yet. See ingest-observability.md.
- Closure: absence requires explicit exact-board completion evidence. Only four audited single-response adapters (Greenhouse, Lever, Ashby, Recruitee) authorize it, including validated empty responses. Failed, malformed, capped and sampled scans cannot close unseen records. Existing static export carry behavior remains a separate limitation; see closure-reliability.md.
- Query expansion: Oracle searches intern/co-op/student/stagiaire; Taleo and Eightfold gain French search; Eightfold preserves Canadian locations. Live Stantec sample reports 802 intern matches versus 600-result cap, 104 co-op and 112 student matches. Overlap/accepted unique incremental yield unmeasured. Oracle worst-case list requests rise to 24, with unchanged 25 detail cap. See query-expansion.md.
- Top-50 metro search: `us_top50_metros.json` holds Census Vintage 2025 population-ranked MSAs (July 1, 2025), verified from the official CSV; `us_metros.py` defines anchor-city rotation. Production CLI opts into `nationwide=True`. Reserves up to two searches inside the existing daily budget before fixed/focus searches; a small plan may leave only one metro slot and reduce other searches. `SERPAPI_US_METRO_SEARCHES` tunes reserved slots. Successful cursor and per-CBSA dates persist in existing `google_jobs_day.json`, already committed by ingest CI. Invalid/failed responses do not advance past a metro. At two successful searches per day a pass takes 25 search days; one takes 50. This is anchor-city discovery, not guaranteed full MSA coverage. Google result dedupe now retains different locations/requisition links.

## 500 pages: built on branch cov-pages (2026-10-18), see metro-pages.md

`top_degree_fields.json` records the user's selected basis: NCES Digest 2023 Table 322.10, verified 2021–22 bachelor's counts. The ten broad fields are Business; Health Professions; Social Sciences and History; Biological and Biomedical Sciences; Psychology; Engineering; Computer and Information Sciences; Visual and Performing Arts; Education; Communication and Journalism. They are field groups, not ten individual degree programs. Direct d24/d25 table URLs returned 404 during verification; do not call 2021–22 data current enrollment data.

Use these ten fields × the 50 metro anchor cities already in `us_top50_metros.json`. Do not substitute a city-proper population ranking. Page generation, listing-to-city matching, links, metadata, sitemap handling and 500-page validation are **still pending**. No generated pages or production pages exist from this request yet. Existing `seo_pages.py` generates landing pages during the Pages build; integrate there or a new helper, preserving existing page paths and tests. Suggested separate namespace `/internships/near/<city>/<field>/`; not a final decision. Show actual counts and truthful empty/sparse states; never invent local listings or advertise statewide inventory as city-local. Provide an accessible browse hub linking all 500 pages. Consider noindex for sparse pages while retaining the requested URLs. Update 2026-10-18: implemented on branch `cov-pages` (not merged): `near_metros.py`, the near section of `seo_pages.py`, `tests/test_near_pages.py`; what was built, the field mapping, the matching method and the indexable counts are in `metro-pages.md`.

## Validation and next work

Latest full local suite: `PYTHONPATH=backend python -m pytest backend/tests -q` — **681 passed, 2 skipped**. `git diff --check` passed. No frontend changes yet.

1. Implement and render/verify the 500 requested major-city pages; test exact Cartesian product, distinct paths, truthful location filtering, empty pages, escaping, canonical URLs and browse links.
2. Inspect discovered board identity and admit Nova Scotia/Sanford with the discovery CLI's explicit apply option, then measure accepted unique yield in a controlled ingestion without paid search calls.
3. Measure expanded-query runtime/yield before raising any caps or budgets. Keep search quotas unchanged unless the user explicitly requests an increase.
4. Done October 19 (branch `cov-metrics`): adapter page counts (discovered, read, discarded by reason, capped) and whole-source outcomes are in the ingest report, with reconciliation; see ingest-observability.md. The Workday `co-op` search is now opt-in through `WORKDAY_EXTRA_KEYWORDS`; see query-expansion.md.
5. Reconcile static export carry-over with authoritative closure evidence and ephemeral CI DB behavior.
6. Review full diff, run relevant tests after further edits, and prepare reviewable changes. User has not requested production deployment.

Europe and Eastern Asia feasibility reports remain here for reference; neither region has been enabled.
