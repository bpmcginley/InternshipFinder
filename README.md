# InternScout

A self-hosted web app that aggregates CS/Quant internship postings, filters them to a
configurable profile (**field · term · location**), scores relevance, tracks open/closed
status, and lets you manage your application status per listing — all on one dashboard.

Default profile: **CS/Quant · Summer 2027 · within 30 mi of Boston (remote included)**.
Change it in `backend/internscout/config.py`.

---

## Two ways to run it

- **Host it free on GitHub Pages** (recommended): a scheduled GitHub Action runs the scraper
  and commits the data; the static dashboard in `docs/` serves it. Full steps in
  **[GITHUB_SETUP.md](GITHUB_SETUP.md)**. (Pages can't run Python, so the scraper runs in
  Actions, not on Pages.)
- **Run locally** with the live API + dashboard — instructions below.

## Quick start (local)

Requires Python 3.10+. From the `backend/` folder:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 1) Pull live listings into the local DB (needs internet)
python -m internscout.run_ingest            # all sources
#   python -m internscout.run_ingest --lists   # Tier 1 GitHub lists only
#   python -m internscout.run_ingest --ats     # Tier 2 Greenhouse/Lever only

# 2) Start the app, then open http://localhost:8000
python -m uvicorn internscout.api:app --port 8000
```

The dashboard is served at `/`. Re-run the ingester any time to refresh (or schedule it,
see below). New-since-last-run listings are flagged **NEW**.

---

## What it does

**Sources (tiered — see the plan doc for the full strategy):**
- **Tier 1 — GitHub community lists** (`vanshb03/Summer2027-Internships`,
  `speedyapply/2027-SWE-College-Jobs`): machine-readable `listings.json`, broad coverage.
- **Tier 2 — Public ATS APIs** (Greenhouse, Lever): the reliable backbone. Employers are
  listed in `internscout/companies_seed.py` — extend that registry to add companies.
- **Tier 4 — Quant watchlist**: portal-based firms (Citadel, Two Sigma, DE Shaw, …) tracked
  in `companies_seed.py` for manual follow-up. (Adzuna/USAJobs Tier 3 and HTML Tier 5 are
  stubs to add next.)

**Pipeline** (`internscout/pipeline.py`): fetch → normalize → classify field → parse term →
geo/radius filter → dedupe across sources → relevance score → persist, with open/closed
tracking (a listing drops to `closed` when it disappears from all its sources).

**Filtering rules:** keeps only internships in your profile's field set, whose term matches
(a year in the title overrides the repo's default cycle), located within the radius **or**
remote. Everything else is dropped.

**Scoring (0–100):** field fit (35) · location (20) · freshness (15) · employer priority (15)
· openness (10) · source confidence (5). Weights live in `internscout/score.py`.

---

## Configuration

Everything about the search is in `backend/internscout/config.py`:

- `Profile.fields` / `core_fields` — which role types to keep and which score highest.
- `Profile.terms` — e.g. `(("Summer", 2027),)`. Add more to widen.
- `center_lat/lng`, `radius_miles`, `include_remote` — the location filter.
- `GITHUB_LISTS` — which community repos to pull.

Add ATS employers in `internscout/companies_seed.py`. To verify a board token, open
`https://boards-api.greenhouse.io/v1/boards/<token>/jobs` or
`https://api.lever.co/v0/postings/<token>?mode=json` in a browser.

### Better location accuracy (optional)
The radius filter uses a built-in Boston-metro gazetteer (no API key needed). To resolve
arbitrary `City, ST` strings via OpenStreetMap at ingest time:
```bash
export INTERNSCOUT_GEOCODE=1     # respect Nominatim's 1 req/sec usage policy
```

---

## Keeping it fresh (scheduling)

Run the ingester on a schedule so the dashboard stays current.

- **macOS/Linux (cron), hourly:**
  ```
  0 * * * * cd /path/to/internscout/backend && .venv/bin/python -m internscout.run_ingest
  ```
- **Windows:** Task Scheduler → new task → action:
  `…\.venv\Scripts\python.exe -m internscout.run_ingest` (start in `…\backend`).

**Timing:** quant Summer 2027 applications open ~**August 2026** and many close by
December — populate the quant watchlist and start scheduling before then.

---

## Tests

Offline, no network required:
```bash
cd backend && PYTHONPATH=. python tests/test_pipeline.py
```
Validates field classification, term parsing, geo/radius logic, cross-source dedupe, and
the full filter+score pipeline against a fixture.

---

## Project layout

```
backend/
  internscout/
    config.py          # profile + sources (edit here)
    db.py, models.py   # SQLite via SQLAlchemy
    geo.py             # remote/radius + optional geocoding
    classify.py        # field tagging
    normalize.py       # raw -> unified listing, term parsing
    dedupe.py          # cross-source merge
    score.py           # relevance score
    pipeline.py        # orchestrator + open/closed tracking
    sources/           # github_lists, greenhouse, lever (+ add more)
    companies_seed.py  # ATS registry + quant watchlist
    api.py             # FastAPI endpoints + serves the dashboard
    run_ingest.py      # CLI entry point
  tests/               # offline end-to-end test + fixture
frontend/
  index.html           # single-file React dashboard (no build step)
```

## API endpoints
`GET /api/stats` · `GET /api/profile` · `GET /api/listings` (filters: `q, field, location,
status, app_state, source, new_only, sort`) · `GET /api/listings/{id}` ·
`PUT /api/listings/{id}/application`.

---

## Roadmap / next
Tier 3 (Adzuna + USAJobs) and Tier 4 portal adapters, listing-detail modal with notes +
deadlines, "new since last visit" digest, and Postgres for larger source counts. See
`internship-finder-plan.md` for the full design.

## Notes
Uses documented public APIs only. Do **not** add LinkedIn scraping — against ToS and blocked.
Personal, single-user use.
