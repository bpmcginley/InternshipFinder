# P-4.2 dated field and employer facts

The before build is frozen parent #309 at `51d59cd1`. The after build uses the same synthetic golden inputs and clock. No production browser, analytics, provider or posting request was made. The displayed counts are fixture data, not current employer totals.

The first sentence now reads `As of {Month day, year}, InternScout lists {count} open student role(s) {in field|at employer}.` The existing count, scope and later summary sentences stay intact. The examples show 29 software engineering roles and 38 Bose roles on November 10, 2026. Missing or invalid export metadata retains the exact undated opening. The date uses the validated export timestamp's calendar day, including its stated offset, consistent with the existing timestamp parser; naive ISO values are treated as UTC. It is not a claim that every posting was checked that day.

## Paired captures

All PNGs use fresh headless Edge contexts at height 1000, with touch enabled at width 375 and reduced motion. The harness serves only a local synthetic origin and blocks external requests, including the existing Cloudflare beacon. It does not reuse logged-in browser state. Reports record zero allowed external requests, no page errors, no horizontal overflow, the unchanged first keyboard link, and exactly one selected-cohort count in each lead. The new sentence is ordinary paragraph text with no focusable element. Screen-reader execution was not performed.

| Page | Width/theme | Before | After |
|---|---|---|---|
| Field | 1280 light | [Before](before-field-1280-light.png) | [After](after-field-1280-light.png) |
| Field | 1280 dark | [Before](before-field-1280-dark.png) | [After](after-field-1280-dark.png) |
| Field | 375 light | [Before](before-field-375-light.png) | [After](after-field-375-light.png) |
| Field | 375 dark | [Before](before-field-375-dark.png) | [After](after-field-375-dark.png) |
| Employer | 1280 light | [Before](before-employer-1280-light.png) | [After](after-employer-1280-light.png) |
| Employer | 1280 dark | [Before](before-employer-1280-dark.png) | [After](after-employer-1280-dark.png) |
| Employer | 375 light | [Before](before-employer-375-light.png) | [After](after-employer-375-light.png) |
| Employer | 375 dark | [Before](before-employer-375-dark.png) | [After](after-employer-375-dark.png) |

Reproduce an offline build with `backend/tests/golden_build.py`'s `prepare(work)` and `build(work)` in a fresh temporary directory at each revision. Then run `node capture.cjs BUILD_SITE before` or `after` with isolated playwright-core tooling and Edge. No repository dependency was added. The golden harness pins its clock and denies network access during generation.

## Bounds and validation

- Full validation: 1695 Python tests passed with three known local skips (Windows link permission, ffmpeg, cryptography), including both golden tests; 319 serial Node22 site tests passed; Python lint has zero errors/warnings; startup report exited zero; publication audit checked 699 files with zero problems. All 699 archive hashes match the manifest.
- Eighteen new focused cases cover the legacy facade, omitted and corrupt dates, valid ISO date/offset/naive timestamps, zero/singular/full counts, and no duplicate opening count. A 53-ID field cohort and 52-role title/location-deduplicated employer cohort both retain their full counts with only 40 rows rendered.
- Date-only rollover preserves semantic lastmod; changes to count, company and actual source citations remain meaningful. The normalization is limited to the exact generated sentence in a field/employer lead paragraph.
- The golden delta is exactly 19 of 699 output paths: ten field HTML pages, eight employer HTML pages and their 18 content-date digests. Every recorded lastmod remains unchanged. No sitemap, feed, canonical path, page membership, CSS, static asset or public data output changes.
- The current-main vocabulary extraction #307 is published and touches taxonomy/source readers, not this package's claimed rendering/model paths. This branch stays stacked on frozen #309; final owner integration must preserve that refactor and rerun affected checks after retargeting.

The package remains needs-bruce and open for independent review, exact-head CI and owner publication. No traffic or search-performance claim is made.
