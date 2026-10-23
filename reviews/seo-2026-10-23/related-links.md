# Related links, 2026-10-23

## Problem and measurement

The local main build at `99eb99b9` contains 2,163 HTML files and 1,705 sitemap URLs.
The audit counts internal HTML anchor instances from sitemap-listed pages, separately counting
anchors inside the existing `section.rel` recommendation sections. Identical export and saved live
sitemap/noindex inputs were used before and after. These are local build counts, not Google crawl
measurements or proof of the ranking-drop cause.

| Measurement | Before | After |
|---|---:|---:|
| Recommendation links to indexed pages | 35,915 | 36,574 |
| Recommendation links to noindex pages | 6,110 | 264 |
| Indexed sources recommending any noindex page | 1,028 | 1 |
| Indexed sources with a majority of noindex recommendations | 97 | 1 |
| All internal links to indexed pages | 128,500 | 129,159 |
| All internal links to noindex pages | 6,111 | 6,111 |
| Indexed URLs without any inbound internal link | 0 | 0 |

The remaining 264 noindex recommendation-section links belong to the complete
`/internships/near/` browsing catalogue, alongside 236 indexed destinations. Removing them would
hide useful browsing destinations and contradict the catalogue's purpose. The complete employer,
major and near catalogues are preserved. On individual indexed pages, primary recommendations
have zero noindex destinations after the change. Noindex sources are unchanged.

## Change and factual boundaries

A post-build pass reads existing eligibility decisions rather than copying their thresholds.
Existing eligible recommendations stay. Thin field-in-place suggestions can point to their existing
indexed field with an explicit "(all places)" label and the actual field-wide role count. Repeated
recommendations are deduplicated across sections. Original noindex browsing links remain available
under "More ways to browse", so this changes recommendation prominence rather than claiming to
remove all crawl paths to noindex pages.

When an indexed employer loses its only recommendation section, fallback fields must share actual
role IDs with it; otherwise it links to the internship hub. No employer specialty is inferred.
The selected indexed employer and field/place pages continue to have useful related destinations.

The final build changes 1,050 HTML files, zero heads and zero job-list sections. Sitemap and noindex
files are byte-identical. Generated paths, eligibility, canonical URLs, metadata and listing data
are unchanged. The two complete catalogues with repeated targets retain their original contents;
individual indexed pages have no repeated related target.

## After PR #140 merged

Normal-merged main `ddfa0288` into this branch, preserving its indexing rules. Repeated the normal
CLI with the same saved live sitemap/noindex inputs and no employer marker, matching the first
deployment of the stricter employer bar. Both main and this branch build 2,163 HTML files and
1,201 sitemap URLs. These current counts supersede the historical pre-#140 table above:

| Measurement | Main after #140 | This branch |
|---|---:|---:|
| Recommendation links to indexed pages | 19,492 | 20,201 |
| Recommendation links to noindex pages | 3,180 | 260 |
| Indexed sources recommending any noindex page | 966 | 1 |
| Indexed sources with a majority of noindex recommendations | 44 | 0 |
| All internal links to indexed pages | 87,327 | 88,036 |
| All internal links to noindex pages | 5,513 | 5,513 |
| Indexed URLs without any inbound internal link | 0 | 0 |

The remaining 260 primary noindex links now belong to the complete employer catalogue. The near
catalogue is no longer an indexed source under #140. Individual indexed pages still have zero
noindex primary recommendations. All browsing destinations remain reachable.
The merged-tree recommendation/SEO/near suites pass: 166 tests.

## Validation and revert

- `cd backend && python -m pytest tests/ -q`: 1,158 passed, two skipped.
- `node --test tests/site/*.test.mjs`: 214 passed.
- Six focused tests verify counts/labels, source eligibility preservation, field fallback,
  complete catalogues, cross-section deduplication and repeat-pass stability.
- Existing SEO and near-page checks pass without weakening their browsing-link requirements.
- One initial full site run under concurrent test/build load hit the existing four-download timing
  test (8 requests instead of 4); its focused rerun passed, followed by the complete 214-test pass.
  This branch changes no site JavaScript or site tests.
- `git diff --check`: passes.

Revert: remove the `prefer_indexed(pages)` call and import at the end of `seo_pages.build()`.
Dated comments explain each rule. No PR #140-owned eligibility or sitemap inclusion rule changes.
