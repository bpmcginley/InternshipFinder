# Built-site crawl audit, 2026-10-23

Historical baseline before PR #140: origin/main `99eb99b9`, committed listing export, and the live sitemap/noindex list
downloaded on October 23. The local build contains 2,163 HTML files and 1,705 sitemap URLs.

| Check | Before | After |
|---|---:|---:|
| Internal href/src and sitemap references checked | 191,481 | 191,481 |
| References to missing files/pages | 0 | 0 |
| Directory links needing a trailing slash | 0 | 0 |

No broken source link was found to repair, and this audit does not explain Google's ranking drop.
The fix is a deployment guard against future broken builds. It checks anchors, script/image/style
references, canonicals and sitemap entries with a case-sensitive file inventory on every platform.
The Pages workflow runs it after generation and refuses to publish a failing build.

Live HEAD checks established that `/privacy` and `/privacy.html`, `/terms` and `/terms.html`,
`/install` and `/install.html`, and explicit `/index.html` URLs all answer 200. They are not
incorrectly reported as redirects. `/employers`, `/pricing` and `/internships` answer 301 to their
slash forms, which answer 200; the built links already use the direct forms. A bare origin URL
implicitly requests `/` and is also accepted. This is a local target-resolution audit plus selected
live HTTP checks, not a request to every live URL or a check of third-party employer sites.

HTMLParser ignores historical tags in comments and script text. Queries/fragments are removed only
for file resolution, so dashboard filters remain intact. No eligibility, noindex decision, canonical,
sitemap inclusion rule or Search Console protection list changed.

Reproduce: copy `docs/` to a separate output folder, run the normal `internscout.seo_pages` CLI
with the same live-state inputs, then run `python -m internscout.site_links OUTPUT` from `backend/`.

Validation: backend **1,156 passed, 2 skipped**; site **214 passed**; four new link regression tests
cover missing anchors/resources/canonicals/sitemap URLs, clean URLs, directory redirects, case
sensitivity, and a complete generated fixture alongside the real static pages and assets.

Revert: remove the `site_links` command from `.github/workflows/pages.yml`; the checker and its tests
can remain available for manual audits.

## Compatibility after PR #140

2026-10-23: merged origin/main `ddfa0288` with `git merge origin/main`, preserving PR #140's
eligibility and noindex rules. The counts above describe the historical pre-#140 build, not the
smaller sitemap selected by #140. Focused combined-head validation:
`python -m pytest tests/test_site_links.py tests/test_seo_pages.py -q`: **145 passed**.
The full-suite results above were recorded before that merge; CI checks the combined PR head.
