"""Tier 3b: Google Jobs search via SerpApi (https://serpapi.com/google-jobs-api).

This is the 'just google search it' layer: it queries Google Jobs for roles matching
free-text queries + location, so companies NOT in our ATS registry still get found
(Walleye, Weiss, and anyone else Google indexes). Requires a SerpApi key (free tier:
100 searches/month) in the SERPAPI_KEY env var. If absent, the source is skipped.
"""
from __future__ import annotations
import os
from .base import client

URL = "https://serpapi.com/search.json"


def fetch_google_jobs(queries: list[str], locations: list[str], api_key: str | None = None,
                      max_searches: int | None = None) -> list[dict]:
    """Query Google Jobs. Stays inside the SerpApi quota by capping searches per run and
    rotating which queries are used (day-based offset), so all disciplines get covered
    across runs instead of always hitting the same few."""
    import datetime
    api_key = api_key or os.environ.get("SERPAPI_KEY")
    if not api_key:
        print("[google_jobs] no SERPAPI_KEY set; skipping")
        return []
    if max_searches is None:
        max_searches = int(os.environ.get("SERPAPI_MAX_SEARCHES", "12"))
    # rotate the query window each day so coverage spreads over time
    per_loc = max(1, max_searches // max(1, len(locations)))
    day = datetime.date.today().toordinal()
    start = (day * per_loc) % max(1, len(queries))
    rotated = queries[start:] + queries[:start]
    picked = rotated[:per_loc]
    print(f"[google_jobs] {len(picked)} quer(ies) x {len(locations)} location(s) "
          f"= {len(picked) * len(locations)} searches (cap {max_searches})")
    out: list[dict] = []
    seen = set()
    used = 0
    with client() as c:
        for loc in locations:
            for q in picked:
                if used >= max_searches:
                    break
                used += 1
                try:
                    r = c.get(URL, params={
                        "engine": "google_jobs", "q": q, "location": loc,
                        "hl": "en", "api_key": api_key,
                    })
                    r.raise_for_status()
                    for j in r.json().get("jobs_results", []):
                        opts = j.get("apply_options") or []
                        link = (opts[0].get("link") if opts else None) or j.get("share_link")
                        key = (j.get("company_name", ""), j.get("title", ""))
                        if key in seen:
                            continue
                        seen.add(key)
                        out.append({
                            "company_name": j.get("company_name", ""),
                            "title": j.get("title", ""),
                            "locations": [j.get("location") or loc],
                            "season": None, "year": None,
                            "url": link, "apply_url": link,
                            "posted_at": None,
                            "description": (j.get("description") or "")[:3000],
                            "active": True,
                            "source": "google_jobs",
                            "source_url": link,
                        })
                except Exception as e:
                    print(f"[google_jobs] '{q}' @ {loc} failed: {e}")
    return out
