"""Recruitee public careers API: <slug>.recruitee.com/api/offers/ (all offers, descriptions included)."""
from __future__ import annotations
from .common import board_item, counts_of, html_to_text, require_robots
from ..classify import is_internship

URL = "https://{token}.recruitee.com/api/offers/"
_US = {"us", "usa", "united states", "united states of america"}
_CANADA = {"ca", "canada"}   # kept since 2026-09-30


def _iso(ts: str | None) -> str | None:
    return ts.replace(" UTC", "Z").replace(" ", "T", 1) if ts else None


def parse_recruitee(payload: dict, co: dict) -> list[dict]:
    out, counts = [], counts_of(co)
    for j in payload.get("offers") or []:
        title = j.get("title", "")
        emp = (j.get("employment_type_code") or "").replace("_", " ")
        if not is_internship(title, emp):
            counts.discard("not_student")
            continue
        locs = j.get("locations") or [{"city": j.get("city"), "state": j.get("state_code") or j.get("state_name"),
                                        "country": j.get("country"), "country_code": j.get("country_code")}]
        us = [l for l in locs if (l.get("country_code") or "").lower() == "us" or (l.get("country") or "").lower() in _US]
        ca = [l for l in locs if (l.get("country_code") or "").lower() == "ca" or (l.get("country") or "").lower() in _CANADA]
        if not us and not ca:
            counts.discard("outside_region")
            continue
        names = [", ".join(x for x in (l.get("city"), l.get("state_code") or l.get("state")) if x) or "United States" for l in us]
        names += [", ".join(x for x in (l.get("city"), l.get("state_code") or l.get("state"), "Canada") if x) for l in ca]
        if j.get("remote"):
            names.append("Remote - US" if us else "Remote - Canada")
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
    payload = r.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("offers"), list) or not all(
            isinstance(job, dict) for job in payload["offers"]):
        raise ValueError("Recruitee response is missing its complete offers list")
    counts = counts_of(co)
    counts.rows(len(payload["offers"]))
    counts.reported(len(payload["offers"]))   # unpaged: every published offer at once
    items = parse_recruitee(payload, co)
    co["_scan_complete"] = True
    return items
