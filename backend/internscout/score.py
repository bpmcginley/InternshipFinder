"""Relevance score 0-100 for ranking within the filtered set. Weights are config-like."""
from __future__ import annotations
from datetime import datetime, timezone
from .config import PROFILE

W = {"field": 35, "location": 20, "freshness": 15, "employer": 15, "openness": 10, "source": 5}
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


def score_parts(*, field_tags, geo, first_seen, status, is_quant_target, sources) -> dict:
    """Points earned per component (each out of W[component]); the total is their sum."""
    # field fit
    core = set(PROFILE.core_fields)
    if any(t in core for t in field_tags):
        field = 1.0
    elif field_tags:
        field = 0.55  # adjacent (data/ml)
    else:
        field = 0.0

    # location: Boston/NYC proper > rest of New England + NYC metro > US-remote
    if geo.get("in_city"):
        location = 1.0
    elif geo.get("within_radius"):
        location = 0.8
    elif geo.get("is_remote"):
        location = 0.5
    else:
        location = 0.2

    values = {
        "field": field,
        "location": location,
        "freshness": _freshness(first_seen),
        "employer": 1.0 if is_quant_target else 0.3,
        "openness": 1.0 if status == "open" else 0.0,
        "source": max((SOURCE_CONFIDENCE.get(s, 0.4) for s in (sources or ["github"])), default=0.4),
    }
    return {k: round(W[k] * v, 1) for k, v in values.items()}


def score_listing(**kw) -> float:
    return round(sum(score_parts(**kw).values()), 1)
