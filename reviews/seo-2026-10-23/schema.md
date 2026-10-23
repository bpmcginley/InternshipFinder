# Structured data review, 2026-10-23

## Problem and evidence

The homepage included three detailed `Offer` objects with exact monthly allowances, although its anonymous visible copy only described a monthly allowance. The pricing page displays the actual tiers and allowances. Google requires structured data to describe content visible on the same page: https://developers.google.com/search/docs/appearance/structured-data/sd-policies.

Removing only the offers would leave a Product missing Google's required `offers`, `review` or `aggregateRating` property. The homepage Product is therefore omitted entirely; no ratings or reviews are invented. The complete Product remains on pricing. Required properties: https://developers.google.com/search/docs/appearance/structured-data/product-snippet#product.

This is a content-consistency correction. The review does not establish that structured data caused the October ranking decline.

The baseline and changed builds both use main `99eb99b9`, the committed listing export dated `2026-10-23T16:05:29.162621+00:00`, and the same saved live sitemap and noindex list. They contain 15,036 usable roles and 2,155 generated pages, plus eight static HTML files.

| Local build measurement | Before | After |
| --- | ---: | ---: |
| HTML files | 2,163 | 2,163 |
| Files with JSON-LD | 2,159 | 2,159 |
| Parseable JSON-LD blocks | 7,174 | 7,174 |
| Product nodes | 2 | 1 |
| Offer nodes | 6 | 3 |
| UnitPriceSpecification nodes | 4 | 2 |
| JobPosting nodes | 0 | 0 |
| CollectionPage nodes | 2,056 | 2,056 |
| BreadcrumbList nodes | 2,155 | 2,155 |
| FAQPage nodes | 800 | 800 |
| Visible FAQ question and answer pairs | 3,199 | 3,199 |
| JSON parse errors | 0 | 0 |

All 2,155 breadcrumb trails have at least two entries, consecutive positions, nonempty names and absolute site URLs. All FAQ questions and answers appear in visible HTML. The new semantic contracts also pass against all 2,159 HTML files containing schema in the changed build.

An independent check against the official current schema.org vocabulary found no unknown types or properties. A domain and range check of 74,354 baseline property values found no actual mismatch, including the valid ISO duration `PT3M` on the install page. References to the shared Organization and WebSite were resolved by their stable IDs. This is a local contract and vocabulary audit, not a remote Google Rich Results Test or an assertion of rich-result eligibility.

## Change

The homepage retains Organization and WebSite, but omits Product and its detailed offers. The full Product offers on `/pricing/` are unchanged. No visible product copy changes.

Offline regression coverage checks the homepage and generated field, place, field-in-place, employer, main hub, employer hub, major hub, pricing, about, comparison and numbers pages. It recursively inspects JSON-LD, checks breadcrumb and FAQ visibility, CollectionPage identity and description, ISO dates, HTTPS URLs, and the emitted Offer and UnitPriceSpecification value types. Adversarial tests ensure a nested JobPosting and an invisible FAQ answer fail.

A required-property guard rejects any Product without offers, reviews or an aggregate rating, including the otherwise valid schema.org Product that an offers-only removal would have left on the homepage.

The visible-text parser follows hidden ancestors, excluding `hidden`, `aria-hidden="true"`, and inline `display:none`, `visibility:hidden` or `collapse`, and `content-visibility:hidden`. Hidden void elements and closed hidden subtrees cannot suppress visible siblings. Nine hidden-ancestor cases and six sibling cases protect these boundaries. This offline check does not compute arbitrary stylesheets or replace a rendered browser inspection.

Only `index.html` differs among the 2,163 built HTML files. The sitemap and `noindex-pages.txt` are byte-identical. No PR #140 indexing symbols, thresholds, noindex rules, sitemap inclusion logic, or `backend/data/search_console_pages.json` were changed.

## Revert

Restore the full homepage Product node from `seo_pages.PRODUCT`, restore its full equality assertion, and remove the new schema contracts if reverting the entire rule.

## Validation

- `cd backend && python -m pytest tests/ -q`: 1,172 passed, two skipped on the final source, including the Google Product required-property guard.
- `node --test tests/site/*.test.mjs`: 214 passed.
- `python -m pytest tests/test_structured_data.py tests/test_seo_pages.py -q`: 155 passed, including hidden-ancestor, visible-sibling and missing Product property cases.
- Local build: 2,155 pages generated; all 2,159 schema-bearing HTML files pass the final hidden-aware semantic checks.
- `git diff --check`: passes.

Performance findings are kept outside this focused change. The measured template review found no clear performance source change to justify.

## Integration with merged PR #140

Merged `origin/main` at `ddfa0288e6671878c0df2401e85384abac09e412` using `git merge`, without rebasing or changing PR #140's indexing rules. The before/after table and byte-identical sitemap comparison above describe the historical schema-only change against `99eb99b9`; they do not attribute PR #140's separate indexing changes to this work.

The combined branch passes 185 focused tests across `test_structured_data.py`, `test_seo_pages.py`, `test_near_pages.py` and `test_widget_data.py`. The post-merge local build still produces 2,155 generated pages plus eight static HTML files. Its 2,159 schema-bearing HTML files pass the same semantic contracts, retaining one Product, three offers and zero JobPosting nodes. Full combined-head suites are checked by PR CI; the full local suite results above were recorded before this integration.
