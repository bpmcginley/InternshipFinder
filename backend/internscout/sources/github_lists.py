"""Tier 1: community-maintained GitHub internship lists (SimplifyJobs listings.json shape).

Record shape observed:
  company_name, title, locations[], season, active, url, date_posted, source, id, sponsorship
No explicit year -> mapped from the repo's cycle_years by season.
"""
from __future__ import annotations
import json
import re
from .base import client
from .common import ScanCounts, report_source
from ..config import GITHUB_LISTS, PROFILE


def _parse(payload: list[dict], source: str, cycle_years: dict,
           counts: ScanCounts | None = None) -> list[dict]:
    wanted = {f"{s} {y}" for s, y in PROFILE.terms}
    out, counts = [], counts if counts is not None else ScanCounts()
    for r in payload:
        if not isinstance(r, dict):
            counts.discard("unreadable")
            continue
        if r.get("is_visible") is False:
            counts.discard("unlisted")
            continue
        season = r.get("season")
        year = cycle_years.get(season) if season else None
        terms = [t for t in (r.get("terms") or []) if isinstance(t, str)]
        if terms:  # Simplify shape: terms ["Summer 2027", "Fall 2026"]; prefer a wanted one
            ok = [t for t in terms if t in wanted]  # summer is the main cycle when several are open
            pick = next((t for t in ok if t.lower().startswith("summer")), ok[0] if ok else terms[0])
            m = re.match(r"\s*(Summer|Fall|Winter|Spring)\s+(\d{4})", pick, re.I)
            if m:
                season, year = m.group(1).title(), int(m.group(2))
        rec_source = (r.get("source") or source).lower()
        out.append({
            "company_name": r.get("company_name", ""),
            "title": r.get("title", ""),
            "locations": r.get("locations") or [],
            "season": season,
            "year": year,
            "url": r.get("url"),
            "apply_url": r.get("url"),
            "posted_at": r.get("date_posted"),
            "active": bool(r.get("active", True)),
            "source": rec_source,
            "source_url": r.get("url"),
        })
    return out


def fetch_github_lists(lists=None, report=None) -> list[dict]:
    """Every configured list's rows. `report` (IngestMetrics.source_result) hears each list's
    outcome, so a list that failed to load is not mistaken for one that is empty today."""
    lists = lists or GITHUB_LISTS
    results: list[dict] = []
    with client() as c:
        for spec in lists:
            counts = ScanCounts()
            try:
                resp = c.get(spec["url"])
                resp.raise_for_status()
                payload = resp.json()
                if not isinstance(payload, list):
                    # A changed file shape used to parse to nothing, which read as an empty list.
                    raise ValueError("listings file is not a list")
                counts.rows(len(payload))
                counts.reported(len(payload))   # the file is the whole list
                items = _parse(payload, spec["source"], spec["cycle_years"], counts)
            except Exception as e:
                print(f"[github_lists] {spec['source']} failed: {e}")
                report_source(report, spec["source"], error=e)
                continue
            results.extend(items)
            report_source(report, spec["source"], items=items, counts=counts)
    return results


def parse_fixture(path: str, source: str = "vanshb03",
                  cycle_years: dict | None = None) -> list[dict]:
    """For tests / offline runs: parse a local listings.json file."""
    cycle_years = cycle_years or {"Summer": 2027, "Fall": 2026, "Winter": 2027, "Spring": 2027}
    with open(path) as f:
        return _parse(json.load(f), source, cycle_years)
