"""Collapse the same role seen across sources by dedupe_key (in a single batch)."""
from __future__ import annotations


def merge_batch(items: list[dict]) -> dict[str, dict]:
    """Return {dedupe_key: merged_item}. Keeps all source links; best fields win."""
    out: dict[str, dict] = {}
    for it in items:
        k = it["dedupe_key"]
        if k not in out:
            it = dict(it)
            it["_sources"] = [(it["source"], it.get("source_url"))]
            out[k] = it
        else:
            cur = out[k]
            cur["_sources"].append((it["source"], it.get("source_url")))
            # prefer a within-radius geo if the current one isn't
            if it["within_radius"] and not cur["within_radius"]:
                for f in ("geo", "location_raw", "lat", "lng", "is_remote",
                          "within_radius", "distance_miles"):
                    cur[f] = it[f]
            if not cur.get("apply_url") and it.get("apply_url"):
                cur["apply_url"] = it["apply_url"]
    return out
