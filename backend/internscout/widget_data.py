"""A small widget feed selected from the complete open listing set, not first-screen previews.

The newest twelve roles for every field plus the global newest twelve are sufficient for every
widget query (limit <= 12, fields combined with OR). A union avoids repeating a role for each field.
The build does the full-corpus work once; an embedded visitor downloads one bounded public file.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlsplit

PER_FIELD = 12
MAX_FIELDS = 128
MAX_BYTES = 2 * 1024 * 1024
FIELD = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _eligible(x: dict, today: str) -> bool:
    if not isinstance(x, dict) or x.get("status") != "open" or not str(x.get("id") or ""):
        return False
    if not isinstance(x.get("title"), str) or not x["title"].strip():
        return False
    try:
        u = urlsplit(x.get("apply_url") or "")
        if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password:
            return False
    except (ValueError, TypeError):
        return False
    deadline = str((x.get("insights") or {}).get("deadline") or "")[:10]
    return not deadline or deadline >= today


def _fields(x: dict) -> list[str]:
    return sorted({t for t in x.get("field_tags") or [] if isinstance(t, str) and FIELD.fullmatch(t)})


def _rank(x: dict) -> tuple:
    return (bool(x.get("posted_at")), x.get("posted_at") or "", x.get("first_seen") or "", str(x["id"]))


def _row(x: dict) -> dict:
    regions = x.get("regions") or []
    loc = next((g.get("loc") for g in regions if isinstance(g, dict) and g.get("loc")), "")
    return {
        "id": str(x["id"]), "title": x["title"], "company_name": x.get("company_name") or "",
        "location": "Remote" if x.get("is_remote") else loc or x.get("state") or "",
        "apply_url": x["apply_url"], "field_tags": _fields(x),
        "salary": x.get("salary") or "", "stage": x.get("stage") or [],
    }


def build(listings: list[dict], generated: datetime, today: str | None = None) -> dict:
    today = today or generated.astimezone(timezone.utc).strftime("%Y-%m-%d")
    # The site load already deduplicates state copies. Keep that guarantee for direct callers too.
    by_id = {}
    for x in sorted((x for x in listings if _eligible(x, today)), key=_rank, reverse=True):
        by_id.setdefault(str(x["id"]), x)
    all_rows = list(by_id.values())
    counts = Counter(t for x in all_rows for t in _fields(x))
    if len(counts) > MAX_FIELDS:
        raise ValueError("Widget field count exceeds its bounded schema")
    used = Counter()
    picked = []
    for i, x in enumerate(all_rows):
        tags = _fields(x)
        if i < PER_FIELD or any(used[t] < PER_FIELD for t in tags):
            picked.append(_row(x))
        used.update(tags)
    return {"schema": 1, "generated_at": generated.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "per_field": PER_FIELD, "total": len(all_rows), "counts": dict(sorted(counts.items())), "rows": picked}


def write(site_dir: str, listings: list[dict], generated: datetime, today: str | None = None) -> int:
    data = json.dumps(build(listings, generated, today), ensure_ascii=False, separators=(",", ":")) + "\n"
    encoded = data.encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise ValueError("Widget feed exceeds its download limit")
    folder = os.path.join(site_dir, "data")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "widget.json"), "wb") as f:
        f.write(encoded)
    return len(encoded)
