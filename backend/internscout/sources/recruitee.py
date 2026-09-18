"""Recruitee public careers API: <slug>.recruitee.com/api/offers/ (all offers, descriptions included)."""
from __future__ import annotations
from .common import board_item, html_to_text, require_robots
from ..classify import is_internship

URL = "https://{token}.recruitee.com/api/offers/"
_US = {"us", "usa", "united states", "united states of america"}


def _iso(ts: str | None) -> str | None:
    return ts.replace(" UTC", "Z").replace(" ", "T", 1) if ts else None


def parse_recruitee(payload: dict, co: dict) -> list[dict]:
    out = []
    for j in payload.get("offers") or []:
        title = j.get("title", "")
        emp = (j.get("employment_type_code") or "").replace("_", " ")
        if not is_internship(title, emp):
            continue
        locs = j.get("locations") or [{"city": j.get("city"), "state": j.get("state_code") or j.get("state_name"),
                                        "country": j.get("country"), "country_code": j.get("country_code")}]
        us = [l for l in locs if (l.get("country_code") or "").lower() == "us" or (l.get("country") or "").lower() in _US]
        if not us:
            continue
        names = [", ".join(x for x in (l.get("city"), l.get("state_code") or l.get("state")) if x) or "United States" for l in us]
        if j.get("remote"):
            names.append("Remote - US")
        desc = html_to_text((j.get("description") or "") + "\n" + (j.get("requirements") or ""))
        out.append(board_item(co, source="recruitee", title=title, locations=names, url=j.get("careers_url"),
                              apply_url=j.get("careers_apply_url"), posted_at=_iso(j.get("published_at")),
                              description=desc, employment_type=emp))
    return out


def fetch_recruitee_board(c, co: dict) -> list[dict]:
    require_robots(c, f"https://{co['ats_token']}.recruitee.com", "/api/offers/",
                   co["ats_token"])
    r = c.get(URL.format(token=co["ats_token"]))
    r.raise_for_status()
    return parse_recruitee(r.json(), co)
