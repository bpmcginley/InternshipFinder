# Employer-specific content, 2026-10-23

## Scope and evidence

Started in a fresh clone of origin/main after PR #140 merged at `ddfa0288`, then explicitly
merged origin/main before implementation. No indexing policy, protected Search Console data,
canonical URL or sitemap inclusion rule changes.

Existing employer pages already had aggregate facts and FAQ answers. At
`backend/internscout/seo_pages.py:1939`, the new breakdown adds the intersections a reader could
not previously compare directly: each of the employer's main hiring fields, its actual open-role
count, year-specific start terms, named locations, and an example title with its original pay text.
The call at line 3579 places it after the listing content, before the existing questions.

Every row comes only from that employer's already deduplicated, open roles. A role can appear
in more than one field or location; visible copy explains that. Missing start terms are counted,
and missing locations or pay are not filled in. A blank-title posting still counts toward all
statistics but cannot become a quoted example. Pay stays as written, including annual amounts,
CAD labels and ranges, without combining currencies or converting annual salaries to hourly pay.
Examples are text; application actions remain in the existing listing rows.

## Normal local build

Main and this branch use the same committed export (15,036 usable roles) and saved live sitemap
and noindex inputs. The CLI applies the first-migration employer setting because the saved live
noindex list has no new employer-rule marker.

| Measurement | Main after #140 | This branch |
|---|---:|---:|
| HTML files | 2,163 | 2,163 |
| Sitemap URLs | 1,201 | 1,201 |
| Employer breakdown sections | 0 | 805 |
| Indexed employer pages with a breakdown | 0 | 545 |
| Distinct breakdowns after removing employer heading | 0 | 805 |
| Maximum field groups in one section | 0 | 3 |

Exactly 805 HTML files change, all employer pages. Heads, JSON-LD and the existing job-list sections
are unchanged. Sitemap and noindex files are byte-identical. Of the 805 sections, 744 show three
field groups, 50 show two, and 11 show one. The median addition is 990 bytes and the largest is
1,470 bytes. No new CSS, JavaScript, images, requests or outbound application links are added.

These are factual differences measured in a frozen local build, not proof of Google's ranking
cause or a promise of recovery. Existing aggregate facts/FAQ wording remains in place.

## Validation and revert

- `cd backend && python -m pytest tests/ -q`: 1,165 passed, two skipped.
- `node --test tests/site/*.test.mjs`: 214 passed.
- Breakdown and complete SEO suite: 147 passed; six new focused regressions pass.
- Independent review reproduced and verified the missing-title safeguard, tested data isolation,
  per-role counting, annual/CAD pay preservation, escaping, ordering and nonmutation.
- Existing paid-placement assertions pass unchanged; examples do not duplicate application links.
- `git diff --check`: passes.

Revert: remove the `employer_breakdown(name, items, main)` call from related content and its helper.
Dated comments mark the rule. Nothing is merged or deployed by this PR.

For lastmod to record this rollout as a new content change, deploy PR #144 and establish its
content manifest before deploying this PR. Without a prior manifest, #144's documented bootstrap
cannot reconstruct when content changed before tracking began.
