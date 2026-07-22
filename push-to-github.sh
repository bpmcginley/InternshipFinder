#!/usr/bin/env bash
# InternScout -> GitHub, one shot. Run from the internscout folder:  bash push-to-github.sh
set -e
cd "$(dirname "$0")"
rm -rf .git
git init -b main
git config user.name  "Bruce McGinley"
git config user.email "brucepmcginley@gmail.com"
git add -A
git commit -m "InternScout: CS/Quant internship finder (scraper + Actions + Pages dashboard)"
git remote add origin https://github.com/bpmcginley/InternshipFinder.git
git branch -M main
git push -u origin main
cat <<'NEXT'

Pushed. Next, in the repo on github.com:
  1. Settings > Actions > General > Workflow permissions > Read and write > Save
  2. Settings > Pages > Deploy from a branch > main > /docs > Save
  3. Actions tab > "Ingest internships" > Run workflow (pulls the first batch)
  Site: https://bpmcginley.github.io/InternshipFinder/
NEXT
