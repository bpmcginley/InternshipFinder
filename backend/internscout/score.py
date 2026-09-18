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


def _freshness(first_seen: datetime | None, posted_at: datetime | None = None) -> float:
    """How new the posting is, counted from the day the employer posted it wherever we know it.

    first_seen is the day InternScout first saw the posting, which is not the same thing as its age.
    2,800 of the 11,019 open listings in one export were first seen more than 21 days after they
    were posted - the whole decay window - and 568 of those more than six months after. Every one of
    them scored as new, so a job posted in March sat at the top of the list beside one posted
    yesterday, and the card said so: "Posted 6 months ago" under a full freshness bar.

    Where no board gave a date the age is genuinely unknown, and unknown is worth the 0.5 this
    function already returns when there is no date at all. It decays from there as we go on holding
    the posting, since first_seen is at least a floor on the age. Handing an undated posting the
    full benefit of first_seen would rank the boards that withhold the date above the ones that
    publish it - Workday discloses on 21% of postings and Greenhouse on 100%.
    """
    now = datetime.now(timezone.utc)

    def decay(d: datetime) -> float:
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return max(0.0, 1.0 - (now - d).total_seconds() / 86400 / 21.0)  # linear over ~3 weeks

    if posted_at:
        return decay(posted_at)
    if not first_seen:
        return 0.5
    return min(0.5, decay(first_seen))


def score_parts(*, field_tags, geo, first_seen, status, sources, posted_at=None, **_) -> dict:
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
        "freshness": _freshness(first_seen, posted_at),
        "openness": 1.0 if status == "open" else 0.0,
        "source": max((SOURCE_CONFIDENCE.get(s, 0.4) for s in (sources or ["github"])), default=0.4),
    }
    return {k: round(W[k] * v, 1) for k, v in values.items()}


def score_listing(**kw) -> float:
    return round(sum(score_parts(**kw).values()), 1)
