"""Workable public widget API: one call per account, descriptions included."""
from __future__ import annotations
from .common import board_item, html_to_text
from ..classify import is_internship

URL = "https://apply.workable.com/api/v1/widget/accounts/{token}"
_US = {"us", "usa", "united states", "united states of america"}


def parse_workable(payload: dict, co: dict) -> list[dict]:
    out = []
    for j in payload.get("jobs") or []:
        title, emp = j.get("title", ""), j.get("employment_type") or ""
        if not is_internship(title, emp):
            continue
        locs = j.get("locations") or [{"country": j.get("country"), "city": j.get("city"), "region": j.get("state")}]
        us = [l for l in locs if (l.get("countryCode") or "").lower() == "us" or (l.get("country") or "").lower() in _US]
        if not us:
            continue
        names = [", ".join(x for x in (l.get("city"), l.get("region")) if x) or "United States" for l in us]
        if j.get("telecommuting"):
            names.append("Remote - US")
        out.append(board_item(co, source="workable", title=title, locations=names,
                              url=j.get("url") or j.get("shortlink"), apply_url=j.get("application_url"),
                              posted_at=j.get("published_on") or j.get("created_at"),
                              description=html_to_text(j.get("description")), employment_type=emp))
    return out


def fetch_workable_board(c, co: dict) -> list[dict]:
    r = c.get(URL.format(token=co["ats_token"]), params={"details": "true"})
    r.raise_for_status()
    return parse_workable(r.json(), co)
