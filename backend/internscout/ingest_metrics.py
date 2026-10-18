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
_LABEL = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}|[1-5][0-9]{2}")


def _label(value) -> str:
    # Labels must be program-defined categories. Never pass arbitrary source text.
    return str(value) if value is not None and _LABEL.fullmatch(str(value)) else "unknown"


def _count(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("counts must be nonnegative integers")
    return value


class IngestMetrics:
    def __init__(self):
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.funnel = Counter()
        self.by_source = {}
        self.rejections = {"normalize": Counter(), "filter": Counter()}
        self.boards = {}
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
                     cause: str | None = None):
        """Record the FINAL outcome after retries; repeated boards replace their outcome.

        The board token is hashed so reports cannot accidentally publish a URL or token.
        Pass an HTTP status or exception class as cause, never str(exception).
        Successful empty boards are distinct from failed or blocked boards.
        """
        if status not in {"success", "failed", "blocked"}:
            raise ValueError("board status must be success, failed or blocked")
        count = _count(count)
        board_id = sha256(str(board).encode("utf-8")).hexdigest()[:16]
        self.boards[(_label(source), board_id)] = {
            "status": status, "returned": count, "cause": _label(cause) if cause else None,
        }

    def export_result(self, total: int, *, open_count: int | None = None,
                      held: int = 0, unplaced: int | None = None):
        self.export = {"total": _count(total), "held": _count(held)}
        for name, value in (("open", open_count), ("unplaced", unplaced)):
            if value is not None:
                self.export[name] = _count(value)
        # The persisted count is run-local; exports can carry prior-run listings.
        # Do not subtract it from export.total and call that a collection loss.

    def as_dict(self) -> dict:
        failures, summary = [], {}
        for (source, board_id), result in sorted(self.boards.items()):
            bucket = summary.setdefault(source, Counter())
            bucket[result["status"]] += 1
            bucket["returned"] += result["returned"]
            if result["status"] != "success":
                failures.append({"source": source, "board_id": board_id, **result})
            elif result["returned"] == 0:
                bucket["empty_success"] += 1
        discrepancies = []
        for before, after, reject_stage in (("fetched", "parsed", "normalize"),
                                             ("parsed", "accepted", "filter")):
            if before in self.funnel and after in self.funnel:
                difference = (self.funnel[before] - self.funnel[after]
                              - sum(self.rejections[reject_stage].values()))
                if difference:
                    discrepancies.append({"between": [before, after],
                                          "unaccounted": difference})
        if "accepted" in self.funnel and "unique" in self.funnel:
            duplicate_count = self.funnel["accepted"] - self.funnel["unique"]
        else:
            duplicate_count = None
        return {
            "schema_version": 1, "started_at": self.started_at,
            "funnel": dict(self.funnel),
            "by_source": {s: dict(c) for s, c in sorted(self.by_source.items())},
            "rejections": {s: dict(c) for s, c in self.rejections.items()},
            "deduplicated": duplicate_count,
            "boards": {s: dict(c) for s, c in summary.items()},
            "board_failures": failures,
            "export": dict(self.export) if self.export is not None else None,
            "discrepancies": discrepancies,
            "limits": ["Adapter-side candidates and rejections are unknown unless instrumented.",
                       "Export totals may include prior-run listings and closed listings.",
                       "Counts do not estimate the share of all online internships covered."],
        }

    def write(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.as_dict(), indent=2) + "\n", encoding="utf-8")
