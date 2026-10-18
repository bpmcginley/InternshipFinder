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

Integration checkpoint (October 16): parent wired the optional normalization callback, pipeline counters/filter rejections, final board scan outcomes and export inventory into `run_ingest`. Reports write via `--metrics PATH` or to `<export-dir>/ingest-report.json`. A database-backed regression checks reconciliation across normalization and geography losses. Source-feed outcomes and adapter-internal candidate counts remain pending.

Adapter-returned postings are already filtered. They do not reveal all candidates a remote board advertised, pages skipped by a cap, HTTP records discarded before parsing, or roles rejected inside adapters. The initial collector therefore leaves `discovered` unknown unless adapters supply candidate counts. Add those counters at page boundaries rather than estimating them from returned items. Likewise discovery of employer boards is a different unit from discovery of listings: use board outcome counts for the former.

Source-level failures outside board scans need their own source outcome instrumentation; an exception aborting the CLI must not be presented as an empty successful feed. Whole-run coverage percentages require an independent employer/sample benchmark and are not inferable from this funnel.

Validation: focused tests cover balanced and unbalanced funnels, deduplication, carried export inventory, final retry outcomes, empty successes, blocked boards, missing measurements, invalid counters, nested JSON output, and exclusion of arbitrary URLs/messages.
