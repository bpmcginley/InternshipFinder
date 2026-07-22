# InternScout -> GitHub, one shot. Run in PowerShell from the internscout folder:
#   Right-click the folder in Explorer > "Open in Terminal", then:  ./push-to-github.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Start clean (a partial .git may have synced from the build environment).
if (Test-Path .git) { Remove-Item -Recurse -Force .git }

git init -b main
git config user.name  "Bruce McGinley"
git config user.email "brucepmcginley@gmail.com"
git add -A
git commit -m "InternScout: CS/Quant internship finder (scraper + Actions + Pages dashboard)"
git remote add origin https://github.com/bpmcginley/InternshipFinder.git
git branch -M main
git push -u origin main

Write-Host ""
Write-Host "Pushed. Next, in the repo on github.com:" -ForegroundColor Green
Write-Host "  1. Settings > Actions > General > Workflow permissions > Read and write > Save"
Write-Host "  2. Settings > Pages > Deploy from a branch > main > /docs > Save"
Write-Host "  3. Actions tab > 'Ingest internships' > Run workflow (pulls the first batch of listings)"
Write-Host "  Site: https://bpmcginley.github.io/InternshipFinder/"
