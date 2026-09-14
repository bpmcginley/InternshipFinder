# InternScout

Finds internships in **New England + the NYC metro** (plus US-remote roles), scores them,
and tracks them on one dashboard. The **Auto-Apply** Chrome extension then fills out each
application for you and stops at the submit button.

Default profile: **all fields · Summer 2027 · New England (ME, NH, VT, MA, RI, CT) or within
50 mi of Midtown Manhattan, plus US-remote.** Change it in `backend/internscout/config.py`.

---

## Parts

- **Scanner** (`backend/`): pulls listings, keeps those in region, scores, exports JSON.
- **Dashboard** (`docs/`): static page on GitHub Pages. Filter, track, and Auto-Apply.
- **Extension** (`extension/`): Deep Dive profile + Auto-Apply agent.
  See **[extension/README.md](extension/README.md)**.

Hosting on GitHub Pages (recommended): **[GITHUB_SETUP.md](GITHUB_SETUP.md)**.

## Quick start (local)

Requires Python 3.10+. From `backend/`:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 1) Pull live listings (needs internet, ~3-4 min) and write the dashboard data
python -m internscout.run_ingest --export ../docs/data
#   --lists    GitHub lists only
#   --ats      registered ATS boards only
#   --google   Google Jobs via SerpApi only (needs SERPAPI_KEY)

# 2a) Static dashboard (works with the extension): serve the repo root
cd .. && python -m http.server 8000     # open http://localhost:8000/docs/

# 2b) Or the API app
python -m uvicorn internscout.api:app --port 8000
```

---

## What it scans

- **Community lists:** `vanshb03/Summer2027-Internships` and SimplifyJobs' master list.
- **ATS boards, scanned whole:** Greenhouse, Lever, Ashby, Workday and SmartRecruiters.
  Board tokens are **auto-discovered** from every apply link seen and saved to
  `backend/data/ats_registry.json`, so coverage grows each run. Seeds are in
  `internscout/companies_seed.py`.
- **Google Jobs** (optional, SerpApi key): Boston, NYC, Hartford/Stamford, Providence,
  Portland ME, Burlington VT / Manchester NH.

**Region rule** (`internscout/region.py`): a posting passes if **any** location is in a New
England state, within 50 mi of Midtown, or US-remote. Remote roles tied to another country
("Remote - HU") or another state ("Remote, TX") are dropped.

**Pipeline** (`internscout/pipeline.py`): fetch → normalize → classify field → parse term →
region filter → dedupe → score → save, with open/closed tracking.

**Scoring (0–100):** field fit · location (Boston/NYC 1.0, rest of region 0.8, remote 0.5) ·
freshness · employer priority · openness · source confidence. Weights in `internscout/score.py`.

---

## Configuration

`backend/internscout/config.py`:
- `Profile.fields`, `Profile.terms`: role types and terms to keep.
- `REGION`: states, NYC center and radius, `include_remote`.
- `GITHUB_LISTS`: community repos to pull.

Environment variables:
- `SERPAPI_KEY`, `SERPAPI_MAX_SEARCHES`: Google Jobs.
- `INTERNSCOUT_GEOCODE=1`: look up unknown towns on OpenStreetMap (1 req/s). Results are
  cached in `backend/data/geocache.json`. `INTERNSCOUT_GEOCODE_MAX` caps lookups per run.
- `INTERNSCOUT_WORKERS`: parallel board fetches (default 16).

Check that every registered board still answers: `python scripts/verify_registry.py`.

---

## Tests

```bash
cd backend && python -m pytest -q
node --test extension/test/guard.test.mjs
```

---

## Project layout

```
backend/
  internscout/
    config.py            profile, region, sources
    region.py, geo.py    region filter + geocoding
    discover.py          ATS board auto-discovery
    sources/             github_lists, greenhouse, lever, ashby, workday, smartrecruiters, google_jobs
    classify.py, normalize.py, dedupe.py, score.py, pipeline.py
    export_static.py     JSON for the dashboard
    run_ingest.py        CLI
  data/                  ats_registry.json, geocache.json (committed)
  scripts/verify_registry.py
  tests/
docs/                    GitHub Pages dashboard + data/
extension/               Auto-Apply extension
```

## Notes
Uses public APIs only. Do **not** add LinkedIn scraping (against ToS, and blocked).
Personal, single-user use. Auto-Apply never submits; you do.
