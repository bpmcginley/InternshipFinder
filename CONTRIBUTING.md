# Contributing to InternScout

Developer notes: how the parts fit, how to run them, and the rules. The student-facing
overview is in [README.md](README.md).

## Parts

- **Scanner** (`backend/`): pulls listings, tags and labels them, exports JSON for the dashboard.
- **Dashboard** (`docs/`): static page on GitHub Pages. Profile, ranking and filters run in the browser.
- **Extension** (`extension/`): Deep Dive profile and the Auto-Apply agent.
  See [extension/README.md](extension/README.md).
- **Worker** (`worker/`): the only server. Checks Google/Microsoft sign-in (.edu gets more), calls Gemini, enforces caps,
  counts chosen states. See [worker/README.md](worker/README.md) and the contract in
  [worker/API.md](worker/API.md).
- **Pages hosting:** [GITHUB_SETUP.md](GITHUB_SETUP.md).

## Backend setup

Requires Python 3.10+.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Ingest

```bash
cd backend
python -m internscout.run_ingest --export ../docs/data     # full run, several minutes
#   --lists     GitHub community lists only
#   --ats       registered ATS boards only
#   --google    Google Jobs via SerpApi only (needs SERPAPI_KEY)
#   --public    public-sector feeds (USAJOBS, NYC Open Data) only
#   --fixture F parse a local listings.json instead of fetching
#   --workers N parallel board fetches
```

Log long runs to a file. Then serve the repo root and open the dashboard:

```bash
python -m http.server 8000     # http://localhost:8000/docs/
```

Coverage report (field clusters with fewer than 15 open listings in the baseline states):

```bash
python -m internscout.coverage ../docs/data/listings.json --min 15
```

In CI, this prints to the job summary.

### Environment variables

| Variable | Use |
|---|---|
| `SERPAPI_KEY`, `SERPAPI_MAX_SEARCHES` | Google Jobs layer (default cap 12 searches per run) |
| `USAJOBS_API_KEY`, `USAJOBS_EMAIL` | USAJOBS Students/Pathways feed (free key) |
| `INTERNSCOUT_WANTED_STATES` | Extra states beyond the baseline that get detail calls and Google searches, e.g. `CA,TX` |
| `INTERNSCOUT_GEOCODE=1`, `INTERNSCOUT_GEOCODE_MAX` | Look up unknown towns on OpenStreetMap (1 req/s, cached in `backend/data/geocache.json`) |
| `INTERNSCOUT_WORKERS` | Parallel board fetches (default 16) |
| `INTERNSCOUT_DB`, `INTERNSCOUT_DATA` | SQLite path and data directory |

## How the scanner works

- **Pipeline** (`internscout/pipeline.py`): fetch, normalize, classify (field, stage, years,
  restrictions), parse term, location filter (US + US-remote), dedupe, score, save, with
  open/closed tracking.
- **Location** (`region.py`, `geo.py`): labels state and metro. It no longer limits results to
  the Northeast.
- **Paid or slow work follows demand.** SerpApi searches and per-job detail calls run only for the
  baseline states (`BASELINE_STATES` in `config.py`: MA, CT, RI, NH, VT, ME, NY, NJ) plus wanted
  states. Wanted states come from the Worker's `/demand` counts.
- **Export** (`export_static.py`): `docs/data/listings/<ST>.json`, `remote.json`, `index.json`,
  `stats.json` and `majors.json`. The dashboard loads only the states a student picked.
- **Majors** (`majors.py`): UMass majors mapped to field tags (direct and related).
- **Scoring:** the backend exports neutral parts only. The dashboard ranks against the
  student's profile.

## Sources

- **Community lists** (`sources/github_lists.py`, `GITHUB_LISTS` in `config.py`).
- **ATS boards, scanned whole** (`sources/__init__.py` `BOARD_FETCHERS`): Greenhouse, Lever,
  Ashby, Workday, SmartRecruiters, Workable, Recruitee, BambooHR, Rippling, Oracle, Taleo,
  ADP, Jobvite.
- **Public feeds:** USAJOBS (`sources/usajobs.py`), NYC Open Data (`sources/nyc_jobs.py`).
- **Google Jobs** via SerpApi (`sources/google_jobs.py`), with query clusters rotated by run number.

**Adding a fetcher:** follow `sources/workable.py` (`parse_x` + `fetch_x_board`). Register it in
`BOARD_FETCHERS`, add token patterns to `discover.py` `PATTERNS`, add a probe to `probe.py`, and
add a fixture test in `backend/tests/test_fetchers.py`. Check the endpoint live first. Drop
anything that needs a login or whose terms forbid automated access.

**Never add:** LinkedIn, Handshake, Indeed or Idealist scraping (login or terms).

## Registry

- Board tokens are auto-discovered from apply links and saved to `backend/data/ats_registry.json`.
- Seeds are in `internscout/companies_seed.py`, labeled by `sector`.
- `probe.py` guesses boards for companies without one. Misses are cached in
  `backend/data/probe_cache.json`.
- Check that every registered board still answers, and drop dead ones:

  ```bash
  cd backend && python scripts/verify_registry.py
  ```

CI commits `backend/data/` each run, so pull before editing.

## Tests

```bash
cd backend && python -m pytest -q
node --test extension/test/*.test.mjs
```

Extension fixture forms: serve the repo root and queue
`http://localhost:8000/extension/test/fixtures/workday-like.html` from the side panel. It should
end at *Ready to submit*, and the page log must never say `FAIL`.

## Worker

See [worker/README.md](worker/README.md). Test locally with `wrangler dev` and vitest.
Deploying and setting secrets (`GEMINI_API_KEY`, `HASH_SALT`, `DEMAND_TOKEN`) is Bruce's job.
Never commit keys.

## Releasing the extension

1. Bump `version` in `extension/manifest.json`.
2. Check the build locally: `python scripts/package_extension.py` (writes `dist/`, which is git-ignored).
3. Tag and push: `git tag ext-v0.3.1 && git push origin ext-v0.3.1`.
   `.github/workflows/release.yml` runs the extension tests, builds the zip and attaches it to a
   GitHub Release. The tag must match the manifest version.

Web Store listing text and permission justifications: [docs/webstore.md](docs/webstore.md).

## Pushing

**Never use `push-to-github.ps1` or `push-to-github.sh`.** They delete `.git` and re-initialize
the repo. Push through a normal clone: copy changes in, commit, `git push origin main`.

## Rules

- Public APIs and public pages only. Respect each site's terms and rate limits.
- Auto-Apply never submits. The submit guard is code; keep its tests passing.
- Don't store student content on the server. The Worker keeps only a hashed ID, usage counts and
  chosen states (see `docs/privacy.html`). Update the privacy page first if that ever changes.
