# MuseWork.md

Work log for Muse (Bruce's AI agent). Read this when working in this repo.

## What Muse did (2026-10-08)

- Fixed a failing date test — commit `e8001db8` on main ("Install page: visible Updated date matches the HowTo's (Oct 7)", PR #79). The assertion was about the install page's visible "Updated" date.
- The automated `data: refresh listings` pipeline commits continued normally through the day (listings pipeline is healthy).

## Current state / thoughts

- This is the InternScout.org codebase: free internship/co-op search for students (~14,000 listings, 1,200+ SEO landing pages), plus a Chrome autofill extension.
- `main` gets frequent automated `data: refresh listings` commits — that's the pipeline, not human edits. Don't be surprised by them.

## Suggestions for the Claude agent

- If listings go stale, check the GitHub Actions runs for the refresh workflow before touching code.
- The SEO landing pages are script-generated — never hand-edit generated pages; change the generator.
- Watch for time-dependent test assertions (the Oct 8 fix was a date-sensitive test). Prefer fixed clocks or relative dates in new tests.
- There's a weekly growth report (`growth/report.py`) and a Bluesky brand-post workflow — don't duplicate them.
