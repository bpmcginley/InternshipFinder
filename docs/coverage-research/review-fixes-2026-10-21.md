# Coverage review fixes — October 21, 2026

Implemented on `codex/fix-coverage-review`, based on reviewed main revision `9284eb41`. Changes remain local and uncommitted in the attached review worktree; no deployment, production ingestion or paid calls. The original October 16 checkout is untouched.

## Fixed

1. Export receives canonical-matchable posting URLs observed in active raw input. A posting retained by a complete list but rejected after detail/location failure can keep its previous exported metadata. This applies even when only one posting fails and the employer does not cross the board-collapse threshold. Explicit closed rows are not revived; carried freshness timestamps and the existing retention bound remain unchanged. Actual unobserved, in-scope missing postings still close.
2. Exported rows now retain `scan_sources`, identifying keyword adapters that actually returned the role. Complete keyword scans cannot remove community-only records or legacy records whose scope is unknown. Complete full-board scans can still remove truly missing postings regardless of original discovery source. Closure logging uses the same scope and raw-observation checks as retention. The listing-schema allowlist explicitly includes this provenance field.
3. New York metro matching uses the existing offline Connecticut town coordinates within the configured Midtown radius. Connecticut's `new_england` kind remains unchanged. Distant, ambiguous, state-only and remote locations remain excluded. CT is included in all ten New York pages' dashboard state links.
4. USAJOBS validates the search-result object, result rows and nonnegative total before parsing or reporting an empty feed. Malformed HTTP 200 responses report failure. Genuine empty results stay empty, and a malformed later page preserves already fetched records while reporting the failure.

## Validation

- `PYTHONPATH=backend python -m pytest backend/tests -q`: **1,148 passed, 2 skipped**.
- `node --test tests/site/*.test.mjs`: **214 passed**.
- Real committed-data build with default near-page generation: **500 distinct major-city pages**, 229 indexable. All ten New York pages include CT in dashboard links.
- `git diff --check`: passed.
- Offline regressions exercise two fresh SQLite ingestion runs, complete lists with failing details, partial enrichment failure without a board collapse, actual absences alongside observed failures, community-only finds above and below the old collapse floor, legacy unknown scope, canonical URL variants, full-board closure, Connecticut boundaries/remote exclusions and malformed/valid/partially failed USAJOBS feeds.
