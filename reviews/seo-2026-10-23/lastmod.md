# Content dates, 2026-10-23

## Problem and evidence

Dates were not blindly reset on every build. They were the newest listing's first_seen date, floored
by the live sitemap, which missed corrections and closures. A controlled six-role fixture changed
three rendered pages after a title/pay correction, but all three retained their prior lastmod.
An unrelated new listing advanced `/pricing/` from September 22 to September 23 despite byte-identical
pricing HTML. These are date-quality defects, not proof of Google's ranking-drop cause.

## Change

An independent semantic digest covers visible content, identity, titles/descriptions, links, real
listing facts and dashboard card data. Routine export-date labels, scripts/styles and paid-placement
boxes do not redated the underlying editorial page. Actual posting and opening dates remain meaningful.
When the digest changes, use the UTC observation day, not a potentially old export timestamp. Keep
the prior date for matching content and preserve the live sitemap floor if a cached manifest is older.

The Pages workflow retrieves `data/page-content-dates.json` and carries it into the fresh build. The
manifest contains only public page paths, hashes and dates, and is bounded and validated before use.
Missing or malformed state bootstraps from the current sitemap-based dates rather than inventing a
history. It cannot reconstruct the date of a change that occurred before this manifest existed.

The writer updates date values only. It does not change indexing thresholds, page membership, thin
arguments, HELD_FILE output or the sitemap inclusion expression. The build signature is unchanged.

## Local build

Same main `99eb99b9` export and saved live-state inputs:

| Measurement | Before | After |
|---|---:|---:|
| Generated pages | 2,155 | 2,155 |
| Sitemap URLs | 1,705 | 1,705 |
| Date changes on identical rebuild | 0 | 0 |
| Manifest entries | 0 | 2,156 including home |

Sitemap membership is unchanged. The identical-input repeat produces a byte-identical sitemap.
The public manifest is 302,809 bytes. The focused fixtures now advance affected dates after title,
pay and location corrections or closures, and keep pricing's date after an unrelated listing arrives.

## Validation and revert

- `cd backend && python -m pytest tests/ -q`: 1,172 passed, two skipped.
- `node --test tests/site/*.test.mjs`: 214 passed.
- Twenty focused date tests cover unchanged rebuilds/new export dates, corrections, closure,
  same-export next-day copy changes, real opening dates, fresh build-directory persistence, homepage
  card changes, monotonic live dates and invalid/future/copied-identity state.
- `git diff --check`: passes.

Revert: remove the page_dates calls in `write()` and the workflow manifest fetch/copy; legacy
first_seen dates remain available. Dated comments mark each new rule. No deployment is performed.
