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
boxes do not redate the underlying editorial page. Actual posting and opening dates remain meaningful.
When the digest changes, use the UTC observation day, not a potentially old export timestamp. Keep
the prior date for matching content and preserve the live sitemap floor if a cached manifest is older.

The Pages workflow retrieves `data/page-content-dates.json` and carries it into the fresh build. The
manifest contains only public page paths, hashes and dates, and is bounded and validated before use.
Missing or malformed state bootstraps from the current sitemap-based dates rather than inventing a
history. It cannot reconstruct the date of a change that occurred before this manifest existed.

The writer updates date values only. It does not change indexing thresholds, page membership, thin
arguments, HELD_FILE output or the sitemap inclusion expression. The build signature is unchanged.

## Source-date review correction

Independent review found that a generic `as of <export date>` match could hide an actual comparison
source-date change. It could also change an unchanged citation's hash when the next export stopped
sharing its date. The correction limits normalization to the generator's exact coverage/count
sentences and their page paths. The template's `Updated` paragraph and known listing descriptions
remain routine; arbitrary `updated`, `as of`, `on`, and `week to` source wording does not.

Date-bearing link destinations, accessibility labels and other element attributes remain factual.
Regression tests cover both unchanged-source/new-export and changed-source/new-export cases for
eight citation contexts, plus the actual about, pricing and comparison pages. A broader fixture
covers the actual listing, employer, tracker, pay, statistics and 500 near-page templates, checking
stable hashes after only their export date labels change while a real source date stays fixed.
The `Updated` check also preserves `Source updated DATE` inside numeric listing descriptions.

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

After merging main `ddfa0288` (PR #140), the fresh build still produces 2,155 generated pages and
2,156 manifest entries. Its sitemap contains 1,201 URLs, matching the unchanged inclusion expression;
the reduction comes from #140's indexing policy. An identical repeat changes zero dates and produces
a byte-identical sitemap. The manifest remains 302,809 bytes. The source-date correction does not
alter any indexing policy or membership decision.
These measurements use the CLI-equivalent first-migration setting (`employer_slack=False`) with
the same saved live sitemap and noindex list for both builds. The saved list predates #140's
employer-rule marker; using the helper's default slack setting would retain additional small
employer pages and would not measure the CLI's actual behavior.

## Validation and revert

- `cd backend && python -m pytest tests/ -q`: 1,190 passed, two skipped after merging #140.
- `node --test tests/site/*.test.mjs`: 214 passed.
- A concurrent-load site run hit the existing four-download timer assertion in
  `tests/site/core.test.mjs:400` (five starts instead of four). The complete command passed with
  214 tests when repeated after the CPU-heavy builds/backend suite finished. No JavaScript changed.
- Thirty-one focused date tests cover unchanged rebuilds/new export dates, corrections, closure,
  same-export next-day copy changes, real opening dates, fresh build-directory persistence, homepage
  card changes, monotonic live dates, invalid/future/copied-identity state, source-date collisions
  and the actual generator's export labels across page templates.
- `git diff --check`: passes.

Revert: remove the page_dates calls in `write()` and the workflow manifest fetch/copy; legacy
first_seen dates remain available. Dated comments mark each new rule. No deployment is performed.
