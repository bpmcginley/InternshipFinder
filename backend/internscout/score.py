"""Neutral relevance score 0-100: the same for every student. The dashboard re-scores each listing
against the student's own majors, year and states; this only orders listings with no profile."""
from __future__ import annotations
from datetime import datetime, timezone

W = {"field": 35, "location": 20, "freshness": 15, "openness": 10, "source": 5}
SOURCE_CONFIDENCE = {  # 0..1
    "greenhouse": 1.0, "lever": 1.0, "ashby": 1.0, "workday": 1.0, "company": 1.0,
    "smartrecruiters": 0.9, "adzuna": 0.6, "usajobs": 0.7,
    "vanshb03": 0.5, "simplify": 0.5, "speedyapply": 0.5, "github": 0.5, "google_jobs": 0.5,
}


def _freshness(first_seen: datetime | None) -> float:
    if not first_seen:
        return 0.5
    if first_seen.tzinfo is None:
        first_seen = first_seen.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - first_seen).total_seconds() / 86400
    return max(0.0, 1.0 - age_days / 21.0)  # linear decay over ~3 weeks


def score_parts(*, field_tags, geo, first_seen, status, sources, **_) -> dict:
    """Points earned per component (each out of W[component]); the total is their sum."""
    # field: how sure we are what the role is (a known field vs "other")
    if any(t != "other" for t in field_tags):
        field = 1.0
    elif field_tags:
        field = 0.4
    else:
        field = 0.0

    # location: a named US place > US-remote
    if geo.get("on_site") or geo.get("within_radius") or geo.get("in_city"):
        location = 1.0
    elif geo.get("is_remote") or geo.get("in_region"):
        location = 0.6
    else:
        location = 0.2

    values = {
        "field": field,
        "location": location,
        "freshness": _freshness(first_seen),
        "openness": 1.0 if status == "open" else 0.0,
        "source": max((SOURCE_CONFIDENCE.get(s, 0.4) for s in (sources or ["github"])), default=0.4),
    }
    return {k: round(W[k] * v, 1) for k, v in values.items()}


def score_listing(**kw) -> float:
    return round(sum(score_parts(**kw).values()), 1)
