# Deploy InternScout to GitHub Pages

GitHub Pages serves **static files only** — it can't run the Python backend. So this repo
uses a two-part setup:

1. **GitHub Actions** runs the scraper on a schedule and commits the listing files in `docs/data/listings/`.
2. **GitHub Pages** serves the static dashboard in `docs/`, which reads that JSON.

Your application statuses (interested/applied/…) are saved in your browser (localStorage),
so they persist per-device without a backend.

---

## One-time setup

### 1. Push to your repo (`bpmcginley/InternshipFinder`)
The remote already exists. Use a normal clone and push. Never delete or re-initialize `.git`:
that wipes history and the data commits Actions made. See `CONTRIBUTING.md` for the full workflow.

```bash
git clone https://github.com/bpmcginley/InternshipFinder.git
cd InternshipFinder
git pull --ff-only
git add -A && git commit -m "your change" && git push origin main
```

Always pull first: every Action run commits `docs/data/` and `backend/data/`. Never force-push.

### 2. Allow Actions to commit
Repo → **Settings → Actions → General → Workflow permissions** →
select **Read and write permissions** → Save.

### 3. Turn on Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch** →
Branch: **main**, folder: **/docs** → Save.
Your site appears at `https://<your-username>.github.io/<repo-name>/` (for this repo, `https://bpmcginley.github.io/InternshipFinder/`) within a minute.

### 4. Get the first batch of data
Repo → **Actions → "Ingest internships" → Run workflow**.
It scrapes the sources, exports JSON, and commits it. The Pages site updates automatically.
After that it re-runs every 6 hours (edit the `cron` in `.github/workflows/ingest.yml`).

---

## Seeding data locally (optional, faster first look)
Instead of waiting for Actions, you can generate the data on your machine and push it:
```bash
cd backend
pip install -r requirements.txt
INTERNSCOUT_GEOCODE=1 python -m internscout.run_ingest --export ../docs/data
cd .. && git add docs/data && git commit -m "seed data" && git push
```

## Customizing the search
Edit `backend/internscout/config.py` (fields, terms, `REGION`, source repos) and
`backend/internscout/companies_seed.py` (seed ATS boards). Commit and push. The next
Action run picks up the changes. Each run also commits `backend/data/` (discovered boards
and the geocode cache), so pull before editing.

Optional: add a `SERPAPI_KEY` secret (Settings → Secrets and variables → Actions) for Google Jobs.

## Auto-Apply
Install the extension (see `extension/README.md`), then reload the Pages site. The
extension works on `https://bpmcginley.github.io/InternshipFinder/*`. If your Pages URL is
different, add it to `content_scripts.matches` in `extension/manifest.json`.

## Notes
- The scrapers hit documented public APIs (GitHub lists, Greenhouse, Lever, Ashby, Workday,
  SmartRecruiters). Do **not** add LinkedIn scraping. It's against their ToS and is blocked.
- `docs/.nojekyll` is included so GitHub Pages serves the files as-is.
- Keep the repo public for free Pages + Actions, or use a paid plan for private.
