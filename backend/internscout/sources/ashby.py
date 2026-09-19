"""Ashby public job-board API."""
from __future__ import annotations
from .common import board_item, stamp_board_newest
from ..classify import is_internship
from ..region import board_state, place_bare_cities

URL = "https://api.ashbyhq.com/posting-api/job-board/{token}"
_US = {None, "", "us", "usa", "united states", "united states of america"}


def _addr(a: dict | None) -> str | None:
    p = (a or {}).get("postalAddress") or {}
    parts = [p.get("addressLocality"), p.get("addressRegion")]
    return ", ".join(x for x in parts if x) or None


def parse_ashby(payload: dict, co: dict) -> list[dict]:
    out, board = [], []
    for j in payload.get("jobs", []):
        if j.get("isListed") is False:
            continue
        board.append(j.get("location"))
        title = j.get("title", "")
        emp = j.get("employmentType") or ""
        if not is_internship(title, emp):
            continue
        locs = [j.get("location"), _addr(j.get("address"))]
        for s in j.get("secondaryLocations") or []:
            locs += [s.get("location"), _addr(s.get("address"))]
        country = (((j.get("address") or {}).get("postalAddress") or {}).get("addressCountry") or "").lower()
        if (j.get("isRemote") or j.get("workplaceType") == "Remote") and not any(
                l and "remote" in l.lower() for l in locs):
            locs.append("Remote - US" if country in _US else f"Remote - {country}")
        out.append(board_item(co, source="ashby", title=title, locations=list(dict.fromkeys(locs)),
                              url=j.get("jobUrl"), apply_url=j.get("applyUrl") or j.get("jobUrl"),
                              posted_at=j.get("publishedAt"), description=j.get("descriptionPlain") or "",
                              employment_type=emp))
    place_bare_cities(out, board_state(board))
    stamp_board_newest(out, [j.get("publishedAt") for j in payload.get("jobs", [])])   # see normalize._zombie
    return out


def fetch_ashby_board(c, co: dict) -> list[dict]:
    resp = c.get(URL.format(token=co["ats_token"]))
    resp.raise_for_status()
    return parse_ashby(resp.json(), co)
