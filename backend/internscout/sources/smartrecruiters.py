"""SmartRecruiters public postings API."""
from __future__ import annotations
from .common import board_item
from ..classify import is_internship

URL = "https://api.smartrecruiters.com/v1/companies/{token}/postings"
MAX_OFFSET = 500


def parse_smartrecruiters(payload: dict, co: dict, token: str) -> list[dict]:
    out = []
    for j in payload.get("content") or []:
        title = j.get("name", "")
        emp = ((j.get("typeOfEmployment") or {}).get("label")) or ""
        if not is_internship(title, emp):
            continue
        loc = j.get("location") or {}
        country = (loc.get("country") or "us").lower()
        if country != "us":
            continue
        where = ", ".join(x for x in (loc.get("city"), loc.get("region")) if x)
        locs = [where]
        if loc.get("remote"):
            locs.append("Remote - US")
        out.append(board_item(co, source="smartrecruiters", title=title, locations=locs,
                              url=f"https://jobs.smartrecruiters.com/{token}/{j.get('id')}",
                              posted_at=j.get("releasedDate"), employment_type=emp))
    return out


def fetch_smartrecruiters_board(c, co: dict) -> list[dict]:
    token, out, offset = co["ats_token"], [], 0
    while offset < MAX_OFFSET:
        r = c.get(URL.format(token=token), params={"q": "intern", "limit": 100, "offset": offset})
        r.raise_for_status()
        data = r.json()
        out += parse_smartrecruiters(data, co, token)
        offset += 100
        if offset >= (data.get("totalFound") or 0):
            break
    return out
