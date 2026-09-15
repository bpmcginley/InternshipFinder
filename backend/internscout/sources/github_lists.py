"""Tier 1: community-maintained GitHub internship lists (SimplifyJobs listings.json shape).

Record shape observed:
  company_name, title, locations[], season, active, url, date_posted, source, id, sponsorship
No explicit year -> mapped from the repo's cycle_years by season.
"""
from __future__ import annotations
import json
import re
from .base import client
from ..config import GITHUB_LISTS, PROFILE


def _parse(payload: list[dict], source: str, cycle_years: dict) -> list[dict]:
    wanted = {f"{s} {y}" for s, y in PROFILE.terms}
    out = []
    for r in payload:
        if not isinstance(r, dict):
            continue
        if r.get("is_visible") is False:
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


def fetch_github_lists(lists=None) -> list[dict]:
    lists = lists or GITHUB_LISTS
    results: list[dict] = []
    with client() as c:
        for spec in lists:
            try:
                resp = c.get(spec["url"])
                resp.raise_for_status()
                payload = resp.json()
                results.extend(_parse(payload, spec["source"], spec["cycle_years"]))
            except (httpx_err := Exception) as e:  # noqa: F841
                print(f"[github_lists] {spec['source']} failed: {e}")
    return results


def parse_fixture(path: str, source: str = "vanshb03",
                  cycle_years: dict | None = None) -> list[dict]:
    """For tests / offline runs: parse a local listings.json file."""
    cycle_years = cycle_years or {"Summer": 2027, "Fall": 2026, "Winter": 2027, "Spring": 2027}
    with open(path) as f:
        return _parse(json.load(f), source, cycle_years)
