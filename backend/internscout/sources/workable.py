"""Workable public widget API: one call per account, descriptions included."""
from __future__ import annotations
from .common import board_item, counts_of, html_to_text, mark_complete, rows_of
from ..classify import is_internship

URL = "https://apply.workable.com/api/v1/widget/accounts/{token}"
_US = {"us", "usa", "united states", "united states of america"}
_CANADA = {"ca", "canada"}   # kept since 2026-09-30


def _canadian(l: dict) -> bool:
    return (l.get("countryCode") or "").lower() == "ca" or (l.get("country") or "").lower() in _CANADA


def parse_workable(payload: dict, co: dict) -> list[dict]:
    out, counts = [], counts_of(co)
    for j in payload.get("jobs") or []:
        title, emp = j.get("title", ""), j.get("employment_type") or ""
        if not is_internship(title, emp):
            counts.discard("not_student")
            continue
        locs = j.get("locations") or [{"country": j.get("country"), "city": j.get("city"), "region": j.get("state")}]
        us = [l for l in locs if (l.get("countryCode") or "").lower() == "us" or (l.get("country") or "").lower() in _US]
        ca = [l for l in locs if _canadian(l)]
        if not us and not ca:
            counts.discard("outside_region")
            continue
        names = [", ".join(x for x in (l.get("city"), l.get("region")) if x) or "United States" for l in us]
        names += [", ".join(x for x in (l.get("city"), l.get("region"), "Canada") if x) for l in ca]
        if j.get("telecommuting"):
            names.append("Remote - US" if us else "Remote - Canada")
        out.append(board_item(co, source="workable", title=title, locations=names,
                              url=j.get("url") or j.get("shortlink"), apply_url=j.get("application_url"),
                              posted_at=j.get("published_on") or j.get("created_at"),
                              description=html_to_text(j.get("description")), employment_type=emp))
    return out


def fetch_workable_board(c, co: dict) -> list[dict]:
    r = c.get(URL.format(token=co["ats_token"]), params={"details": "true"})
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict):
        raise ValueError("Workable widget response is not an object")
    rows = rows_of(payload, "jobs")
    if rows is not None:   # a body without a jobs list measured nothing
        counts = counts_of(co)
        counts.rows(len(rows))
        counts.reported(len(rows))   # unpaged: every published job at once
    items = parse_workable(payload, co)
    # The widget call takes no paging parameters and answers with every published job at once,
    # so a well-formed jobs list (empty included) is the whole board. A body without one is not
    # read as an empty board.
    mark_complete(co, rows is not None)
    return items
