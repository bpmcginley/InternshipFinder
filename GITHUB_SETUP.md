# Deploy InternScout to GitHub Pages

GitHub Pages serves **static files only** — it can't run the Python backend. So this repo
uses a two-part setup:

1. **GitHub Actions** runs the scraper on a schedule and commits `docs/data/listings.json`.
2. **GitHub Pages** serves the static dashboard in `docs/`, which reads that JSON.

Your application statuses (interested/applied/…) are saved in your browser (localStorage),
so they persist per-device without a backend.

---

## One-time setup

### 1. Push to your repo (`bpmcginley/InternshipFinder`)
The remote already exists. From the `internscout/` folder, run the included one-shot script:

- **Windows (PowerShell):** open this folder in Terminal, then:
  ```powershell
  ./push-to-github.ps1
  ```
- **macOS/Linux:**
  ```bash
  bash push-to-github.sh
  ```

The script re-initializes git cleanly, commits everything, sets the remote to
`https://github.com/bpmcginley/InternshipFinder.git`, and pushes to `main`. It'll ask you to
authenticate to GitHub the first time (browser sign-in via Git Credential Manager, or a
Personal Access Token as the password).

> If the push is rejected because the repo already has commits, and you're sure it should be
> replaced, append `--force`: `git push -u origin main --force`.

### 2. Allow Actions to commit
Repo → **Settings → Actions → General → Workflow permissions** →
select **Read and write permissions** → Save.

### 3. Turn on Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch** →
Branch: **main**, folder: **/docs** → Save.
Your site appears at `https://<your-username>.github.io/internscout/` within a minute.

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
Edit `backend/internscout/config.py` (fields, term, Boston radius, source repos) and
`backend/internscout/companies_seed.py` (ATS company tokens). Commit and push — the next
Action run picks up the changes.

## Notes
- The scrapers hit documented public APIs (GitHub lists, Greenhouse, Lever). Do **not** add
  LinkedIn scraping — it's against their ToS and is blocked.
- `docs/.nojekyll` is included so GitHub Pages serves the files as-is.
- Keep the repo public for free Pages + Actions, or use a paid plan for private.
