"""Rippling ATS public board API. It returns one row per (job, location), so rows are grouped by job."""
from __future__ import annotations
from .common import board_item
from ..classify import is_internship

URL = "https://api.rippling.com/platform/api/ats/v1/board/{token}/jobs"


def parse_rippling(payload, co: dict) -> list[dict]:
    rows = payload if isinstance(payload, list) else (payload or {}).get("jobs") or []
    jobs: dict[str, dict] = {}
    for j in rows:
        title = j.get("name", "")
        if not is_internship(title):
            continue
        e = jobs.setdefault(j.get("uuid") or j.get("url"), {"title": title, "url": j.get("url"), "locs": []})
        label = (j.get("workLocation") or {}).get("label")
        if label and label not in e["locs"]:
            e["locs"].append(label)
    return [board_item(co, source="rippling", title=e["title"], locations=e["locs"], url=e["url"]) for e in jobs.values()]


def fetch_rippling_board(c, co: dict) -> list[dict]:
    r = c.get(URL.format(token=co["ats_token"]))
    r.raise_for_status()
    return parse_rippling(r.json(), co)
