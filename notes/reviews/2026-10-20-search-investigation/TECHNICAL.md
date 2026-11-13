# Technical search investigation — October 20, 2026

Scope: inspect deployment/source history and current public crawlability for pages identified in the owner's Search Console review. This record contains public technical evidence, not private Search Console exports.

## Verified

- All 70 most recent `pages.yml` runs, from October 14 through October 20, concluded successfully. Representative October 15–18 build logs report 1,584, 1,596, 1,600 and 1,594 generated pages, respectively. No replacement deployment containing only the dashboard or failed landing-page build was found.
- October 17's main-branch commits were automated listing refreshes. The first code merge after October 15 was the October 18 15:20 UTC digest signup fix (`0eedb096`); its only landing-generator change adjusted the examples on `/digest/`.
- The October 13 thin-page policy affects field-in-place combination pages; it does not mark a field root such as `/internships/cybersecurity/` or an employer page `noindex`. The October 14 landing redesign preserved server-rendered listings and self-canonicals.
- Live checks returned HTTP 200, one correct self-canonical, no robots `noindex` directive/header, and server-rendered job rows for cybersecurity, Under Armour, Sun Life, Calgary, Atrium Health, Essentia Health, KKR, Axiom Space, EQ Bank and UL Solutions. Between 4 and 40 listing rows were present on each page. Smaller counts can be retained by the existing hysteresis rule.
- The live sitemap has 1,690 unique URLs, all on the primary HTTPS host, with no future last-modified dates. Its paths do not overlap the 437 entries in the live `noindex-pages.txt`. All five specifically checked cybersecurity / EQ Bank / Essentia Health / KKR / UL Solutions paths are in the sitemap.
- HTTP, `www`, missing trailing slash and the former GitHub Pages host resolve to the correct primary HTTPS URL. A made-up internship path returns an actual 404. The directly addressable `/404.html` has `noindex`.
- Homepage source contains commented-out historical title tags; those comments are not additional document title elements.

## Source locations

- `backend/internscout/seo_pages.py`: `keep_at`, `combo_indexed`, `build` and `write` implement retention, combination indexing, server rendering and sitemap/robots output.
- `.github/workflows/pages.yml`: failed builds leave the previous good site live; there is no dashboard-only fallback. It fetches the prior sitemap and noindex list for retention decisions.
- `backend/tests/test_seo_pages.py`: existing coverage checks sitemap/robots, stable retained pages, index thresholds, noindex scope, traffic exemptions and monotonic lastmod.

## Validation and conclusion

`python -m pytest tests/test_seo_pages.py -k 'sitemap or robots or thin or indexed or lastmod or live_page or live_paths or noindex or only_field or page_people' -q` from `backend/`: **16 passed**, 119 deselected.

No technical indexing defect explaining the reported decline was demonstrated in this workstream, so no production behavior was changed. Successful deployments and current HTTP checks cannot prove that every URL was reachable to every crawler at every historical moment. Ranking, demand and query/device/country composition require the separate Search Console investigation; they cannot be inferred from this technical pass alone.
