# Measuring ingestion losses

`backend/internscout/ingest_metrics.py` provides a run-local, JSON-serializable collector. It does not query services or change listing acceptance. Reports contain aggregate counts, code-defined reason labels, and hashed board identifiers; never pass listing text, URLs, credentials or exception messages as labels.

## Coordinator integration

Create one `IngestMetrics()` per CLI run. After final retry results, call `board_result(ats, token, status, count=len(items), cause=...)`, using `success`, `failed`, or `blocked`; use HTTP statuses or exception class names for causes. Call from the coordinator thread. A repeated source/token replaces the preceding outcome so a recovered board is not counted as a failure. Zero-return successes and robots exclusions remain separate categories.

Before normalization, count `fetched` with the number of raw adapter-returned postings, ideally grouped by `source`. Add an optional `on_reject` callback to `normalize(raw)` that reports exactly one code-defined reason before each early return: `missing_identity`, `dead_url`, `not_student_opportunity`, `no_field_tags`, or `stale_untermed`. Existing callers retain the same return value and need no changes.

```python
n = normalize(raw, on_reject=lambda reason: metrics.reject(reason, source=raw.get("source")))
if n is None:
    continue
metrics.count("parsed", source=raw.get("source"))
# On each pipeline filter's first rejection:
metrics.reject("term_filter", stage="filter", source=raw.get("source"))
# Other filter reasons: field_filter, outside_region.
```

Count `accepted` after field/term/region filters, `unique` after merge, and `persisted` only after successful database commit. Do not re-run normalization just to infer rejection reasons. When exporting, call `export_result(stats["total"], open_count=stats["open"], held=stats["held"])`. Add `unplaced` only if measured at the shard-writing boundary. Finally `metrics.write(path)` writes a report to an explicit output path.

The report reconciles `fetched = parsed + normalize_rejections` and `parsed = accepted + filter_rejections`. Nonzero `discrepancies` identify missing instrumentation or double counting. `accepted - unique` measures merges. Missing stages are absent, not zero. Export totals include historical carried listings and possibly closed rows, so they cannot be directly subtracted from run-local persisted listings to claim losses.

## Boundaries and next measurements

Integration checkpoint (October 16): parent wired the optional normalization callback, pipeline counters/filter rejections, final board scan outcomes and export inventory into `run_ingest`. Reports write via `--metrics PATH` or to `<export-dir>/ingest-report.json`. A database-backed regression checks reconciliation across normalization and geography losses.

Discovery of employer boards is a different unit from discovery of listings: use board outcome counts for the former. Whole-run coverage percentages require an independent employer/sample benchmark and are not inferable from this funnel.

Validation: focused tests cover balanced and unbalanced funnels, deduplication, carried export inventory, final retry outcomes, empty successes, blocked boards, missing measurements, invalid counters, nested JSON output, and exclusion of arbitrary URLs/messages.

## Adapter page counts and whole-source outcomes (October 19)

Before this change the report started at `fetched`, the postings an adapter handed back. Those are already filtered, so the report could not see what a board listed, what an adapter threw away, or whether a page cap cut the read short. It also had no record of the community lists, Google Jobs or the public feeds, each of which caught its own errors and returned an empty list. A failed feed and an empty one looked the same.

### How adapters count

`sources/common.py` has one small collector, `ScanCounts`. `run_ingest._fetch_board` attaches a fresh one to each board scan (`co["_counts"]`, read back with `counts_of(co)`), and every board adapter counts into it at its page boundaries:

- `discovered`: the total the API says it holds, summed over the scan's searches. For an unpaged list (Greenhouse, Lever, Ashby, Recruitee, Workable, BambooHR, Rippling's bare array) the list is the whole board, so its length is the total; BambooHR's and Greenhouse's own stated totals win when present. HTML adapters (iCIMS portal, SuccessFactors, Jobvite, JazzHR) report no total, so `discovered` is absent for them. If any one search of a scan lacks a total, the whole scan's `discovered` is absent, since a partial sum would look like a whole one.
- `read`: rows actually received, page by page.
- `discarded`: rows read but not returned, each with one code-defined reason: `not_student`, `outside_region`, `duplicate` (the same job from another keyword, or another location row), `unlisted`, `expired`, `unreadable`.
- `capped` and `stops`: whether a ceiling ended the read with results left. `page_cap` is the adapter's page or offset limit, `dry_pages` is Workday's (and the iCIMS portal's) stop on pages with no internship, `row_limit` is a single request whose row limit was filled (NYC Open Data), and `quota` is Google Jobs running out of searches.

A retried board gets fresh counts, so only the attempt that counted is reported. Counts ride back on `BoardItems.counts`, and `scan_boards` hands them to `metrics.board_result(..., scan=...)` on the coordinator thread. A fetcher that does not count (a test double, a future adapter) reports nothing, not zeros.

Non-board sources take an optional `report` callback, which `run_ingest` sets to `metrics.source_result`. `common.report_source` turns each run into exactly one status: `success`, `empty` (it answered and returned nothing), `partial` (some of Google's searches failed), `failed` (an error stopped it, whatever it returned before that), or `skipped` (no API key, a push-triggered run, already searched today, no budget). The cause is an HTTP status or an exception class name, never a message or URL. Two silent cases now fail loudly: a community list whose file is no longer a JSON list, and a UHN or NYC response without its rows list.

### What the report shows

Schema version 2 adds:

- `board_scans`, per ATS: boards counted, `read_boards`, `read`, `returned_by_read_boards`, `discarded` by reason, `discovered_boards` and `discovered` (only over boards whose API gave a total), `capped` boards and `stops` by reason. A total that no board measured is left out.
- Per-board counts are not listed one by one; a board appears individually only in `discrepancies` (or in `board_failures`, which carry no scan counts because a failed scan's partial counts prove nothing).
- `sources`, per non-board source: `status`, `returned`, `cause` when there is one, and its own `scan` counts. Sources not run in this mode are absent.

### Reconciliation

Checked per board and per feed, only where both sides were measured:

- `read >= returned`;
- `read = returned + discarded` (every row read is accounted for);
- `discovered >= read` (an API total below what was read means the board changed between pages or the adapter miscounted).

And per ATS, the sum of what successful boards returned has to equal what the pipeline counted as `fetched` for that source. Any miss is a row in `discrepancies` with the source, the hashed board id, the check and the difference. `discovered > read` is not a discrepancy: it is what a cap, a dry stop or a short page looks like, and the `stops` field says which.

### Limits

- `discovered` is the API's count of search matches, not of internships. Workday's fuzzy `intern` search counts "Internal Audit Manager" too, and multi-keyword searches count the same job once per keyword (those repeats come back as `duplicate` discards).
- HTML adapters have no total, so `discovered` stays absent for them. Their `read` counts the cards or rows the parser recognized; a changed template that hides rows from the parser hides them from the count too.
- Rows lost before parsing (a page that failed, a board that failed) are board or source failures, not discards.
- Google Jobs reports no totals; only its rows read, repeats and search failures are known.

Validation: `tests/test_scan_counts.py` covers every API adapter (discovered, read, discarded, empty boards, caps by reason, missing totals), each HTML adapter, duplicates across searches and location rows, retries, uninstrumented fetchers, reconciliation failures, label sanitizing, every non-board source failing, answering empty, failing part way and being skipped, and the CLI writing those outcomes to the report.
