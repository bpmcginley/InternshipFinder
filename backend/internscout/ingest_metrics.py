"""Run-local coverage accounting. Never retain listing text, URLs or exception messages.

Counts describe observed input, not a claim about all internships on the internet.
Call from the coordinator thread after fetch workers finish; this collector is not
thread-safe. Missing stages remain absent rather than masquerading as zero.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re


STAGES = frozenset({"discovered", "fetched", "parsed", "accepted", "unique", "persisted"})
SOURCE_STATUSES = frozenset({"success", "empty", "partial", "failed", "skipped"})
_LABEL = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}|[1-5][0-9]{2}")


def _label(value) -> str:
    # Labels must be program-defined categories. Never pass arbitrary source text.
    return str(value) if value is not None and _LABEL.fullmatch(str(value)) else "unknown"


def _count(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("counts must be nonnegative integers")
    return value


def _scan(scan: dict) -> dict:
    """Validated page counts: measured keys only, nonnegative counts, labelled reasons."""
    out = {}
    for key in ("discovered", "read"):
        if scan.get(key) is not None:
            out[key] = _count(scan[key])
    if "read" in out:
        out["discarded"] = {_label(r): _count(n) for r, n in (scan.get("discarded") or {}).items()}
    out["capped"] = bool(scan.get("capped"))
    if scan.get("stops"):
        out["stops"] = {_label(r): _count(n) for r, n in scan["stops"].items()}
    return out


def _scan_gaps(scan: dict, returned: int) -> list[dict]:
    """Where one scan's counts fail discovered >= read >= returned, or read = returned + discarded."""
    gaps = []
    read, discovered = scan.get("read"), scan.get("discovered")
    if read is not None:
        if read < returned:
            gaps.append({"check": "read>=returned", "difference": returned - read})
        unaccounted = read - returned - sum(scan.get("discarded", {}).values())
        if unaccounted:
            gaps.append({"check": "read=returned+discarded", "difference": unaccounted})
        if discovered is not None and discovered < read:
            gaps.append({"check": "discovered>=read", "difference": read - discovered})
    elif discovered is not None and discovered < returned:
        gaps.append({"check": "discovered>=returned", "difference": returned - discovered})
    return gaps


def _new_scan_bucket() -> dict:
    return {"boards": 0, "read_boards": 0, "read": 0, "returned_by_read_boards": 0,
            "discovered_boards": 0, "discovered": 0, "discarded": Counter(),
            "capped": 0, "stops": Counter()}


def _add_scan(bucket: dict, scan: dict, returned: int) -> None:
    bucket["boards"] += 1
    if "read" in scan:
        bucket["read_boards"] += 1
        bucket["read"] += scan["read"]
        bucket["returned_by_read_boards"] += returned
        bucket["discarded"].update(scan.get("discarded", {}))
    if "discovered" in scan:
        bucket["discovered_boards"] += 1
        bucket["discovered"] += scan["discovered"]
    if scan.get("capped"):
        bucket["capped"] += 1
        bucket["stops"].update(scan.get("stops", {}))


def _finish_scan_bucket(bucket: dict) -> dict:
    """Totals only for what some board measured; a total no board measured is left out."""
    out = {"boards": bucket["boards"], "capped": bucket["capped"]}
    if bucket["stops"]:
        out["stops"] = dict(bucket["stops"])
    if bucket["read_boards"]:
        out.update(read_boards=bucket["read_boards"], read=bucket["read"],
                   returned_by_read_boards=bucket["returned_by_read_boards"],
                   discarded=dict(bucket["discarded"]))
    if bucket["discovered_boards"]:
        out.update(discovered_boards=bucket["discovered_boards"], discovered=bucket["discovered"])
    return out


class IngestMetrics:
    def __init__(self):
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.funnel = Counter()
        self.by_source = {}
        self.rejections = {"normalize": Counter(), "filter": Counter()}
        self.boards = {}
        self.sources = {}
        self.export = None

    def count(self, stage: str, count: int = 1, *, source: str | None = None):
        if stage not in STAGES:
            raise ValueError(f"unknown stage: {stage}")
        self.funnel[stage] += _count(count)
        if source is not None:
            self.by_source.setdefault(_label(source), Counter())[stage] += count

    def reject(self, reason: str, *, source: str | None = None, stage: str = "normalize"):
        if stage not in self.rejections:
            raise ValueError("rejection stage must be normalize or filter")
        reason = _label(reason)
        self.rejections[stage][reason] += 1
        if source is not None:
            key = f"rejected_{stage}_{reason}"
            self.by_source.setdefault(_label(source), Counter())[key] += 1

    def board_result(self, source: str, board: str, status: str, *, count: int = 0,
                     cause: str | None = None, complete: bool = False, scan: dict | None = None):
        """Record the FINAL outcome after retries; repeated boards replace their outcome.

        The board token is hashed so reports cannot accidentally publish a URL or token.
        Pass an HTTP status or exception class as cause, never str(exception).
        Successful empty boards are distinct from failed or blocked boards.
        `scan` is the adapter's page counts (sources.common.ScanCounts.as_dict); keys it leaves
        out were not measured and stay out of the report.
        """
        if status not in {"success", "failed", "blocked"}:
            raise ValueError("board status must be success, failed or blocked")
        count = _count(count)
        board_id = sha256(str(board).encode("utf-8")).hexdigest()[:16]
        result = {"status": status, "returned": count, "cause": _label(cause) if cause else None}
        if status == "success" and complete:
            # Read to the end (scan_evidence): absence from this board closed postings this run.
            result["complete"] = True
        if status == "success" and scan:
            result["scan"] = _scan(scan)
        self.boards[(_label(source), board_id)] = result

    def source_result(self, source: str, status: str, *, count: int = 0,
                      cause: str | None = None, scan: dict | None = None):
        """Record a whole non-board source (community list, Google Jobs, a public feed).

        Statuses: success, empty (ran and returned nothing), partial (some of its searches
        failed), failed (an error stopped it), skipped (not run: no key, quota, schedule).
        A repeated source replaces its outcome. Cause is a code-defined label, never a message.
        """
        if status not in SOURCE_STATUSES:
            raise ValueError(f"source status must be one of {sorted(SOURCE_STATUSES)}")
        result = {"status": status, "returned": _count(count)}
        if cause:
            result["cause"] = _label(cause)
        if scan:
            result["scan"] = _scan(scan)
        self.sources[_label(source)] = result

    def export_result(self, total: int, *, open_count: int | None = None,
                      held: int = 0, unplaced: int | None = None):
        self.export = {"total": _count(total), "held": _count(held)}
        for name, value in (("open", open_count), ("unplaced", unplaced)):
            if value is not None:
                self.export[name] = _count(value)
        # The persisted count is run-local; exports can carry prior-run listings.
        # Do not subtract it from export.total and call that a collection loss.

    def as_dict(self) -> dict:
        failures, summary, scans, discrepancies = [], {}, {}, []
        for (source, board_id), result in sorted(self.boards.items()):
            bucket = summary.setdefault(source, Counter())
            bucket[result["status"]] += 1
            bucket["returned"] += result["returned"]
            if result.get("complete"):
                bucket["complete"] += 1
            if result["status"] != "success":
                failures.append({"source": source, "board_id": board_id, **result})
            elif result["returned"] == 0:
                bucket["empty_success"] += 1
            scan = result.get("scan")
            if scan:
                _add_scan(scans.setdefault(source, _new_scan_bucket()), scan, result["returned"])
                for gap in _scan_gaps(scan, result["returned"]):
                    discrepancies.append({"between": ["scan", "returned"], "source": source,
                                          "board_id": board_id, **gap})
        feeds = {}
        for source, result in sorted(self.sources.items()):
            feeds[source] = dict(result)
            for gap in _scan_gaps(result.get("scan") or {}, result["returned"]):
                discrepancies.append({"between": ["scan", "returned"], "source": source, **gap})
        for before, after, reject_stage in (("fetched", "parsed", "normalize"),
                                             ("parsed", "accepted", "filter")):
            if before in self.funnel and after in self.funnel:
                difference = (self.funnel[before] - self.funnel[after]
                              - sum(self.rejections[reject_stage].values()))
                if difference:
                    discrepancies.append({"between": [before, after],
                                          "unaccounted": difference})
        # What the boards handed over has to be what the pipeline counted as fetched for them.
        # Only checked where both sides were measured for that source.
        for source, bucket in sorted(summary.items()):
            fetched = self.by_source.get(source, {}).get("fetched")
            if fetched is not None and fetched != bucket["returned"]:
                discrepancies.append({"between": ["boards_returned", "fetched"], "source": source,
                                      "unaccounted": bucket["returned"] - fetched})
        if "accepted" in self.funnel and "unique" in self.funnel:
            duplicate_count = self.funnel["accepted"] - self.funnel["unique"]
        else:
            duplicate_count = None
        return {
            "schema_version": 2, "started_at": self.started_at,
            "funnel": dict(self.funnel),
            "by_source": {s: dict(c) for s, c in sorted(self.by_source.items())},
            "rejections": {s: dict(c) for s, c in self.rejections.items()},
            "deduplicated": duplicate_count,
            "boards": {s: dict(c) for s, c in summary.items()},
            "board_scans": {s: _finish_scan_bucket(b) for s, b in scans.items()},
            "board_failures": failures,
            "sources": feeds,
            "export": dict(self.export) if self.export is not None else None,
            "discrepancies": discrepancies,
            "limits": ["board_scans covers successful board scans only. A key missing there was "
                       "not measured, and discovered sums only the boards whose API reported a total.",
                       "Export totals may include prior-run listings and closed listings.",
                       "Counts do not estimate the share of all online internships covered."],
        }

    def write(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.as_dict(), indent=2) + "\n", encoding="utf-8")
