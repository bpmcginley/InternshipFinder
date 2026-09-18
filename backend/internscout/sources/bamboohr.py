"""BambooHR careers JSON: <slug>.bamboohr.com/careers/list, with a detail call for descriptions.

Each row carries two location fields and a tenant fills one or the other, never both. atsLocation
has a country; the plain location has no country field at all and puts one in 'state' for jobs
outside the US ("Haarlem, Netherlands"). Reading only atsLocation lost every job posted the other
way, because the empty shape is still a dict and so still wins an `or`: those jobs came out with
no location, which dropped them from the export and, before that, from the detail call that gives
a listing its description.
"""
from __future__ import annotations
from .common import board_item, html_to_text, require_robots
from ..classify import is_internship
from ..geo import STATE_NAMES
from ..region import maybe_in_region

LIST_URL = "https://{token}.bamboohr.com/careers/list"
DETAIL_URL = "https://{token}.bamboohr.com/careers/{id}/detail"
MAX_DETAIL = 15
_US = {"", "us", "usa", "united states", "united states of america"}


def parse_bamboohr(payload: dict, co: dict, token: str) -> list[dict]:
    out = []
    for j in payload.get("result") or []:
        title, emp = j.get("jobOpeningName", ""), j.get("employmentStatusLabel") or ""
        if not is_internship(title, emp):
            continue
        ats, plain = j.get("atsLocation") or {}, j.get("location") or {}
        city = ats.get("city") or plain.get("city")
        state = ats.get("state") or ats.get("province") or plain.get("state")
        if ats.get("country"):
            if ats["country"].strip().lower() not in _US:
                continue
        elif state and state.strip().lower() not in STATE_NAMES:
            continue     # no country field to go on, so a state that is not one of the 50 is abroad
        names = [", ".join(x for x in (city, state) if x)]
        if j.get("isRemote"):
            names.append("Remote - US")
        it = board_item(co, source="bamboohr", title=title, locations=names,
                        url=f"https://{token}.bamboohr.com/careers/{j.get('id')}", employment_type=emp)
        it["_bh_id"] = j.get("id")
        out.append(it)
    return out


def fetch_bamboohr_board(c, co: dict) -> list[dict]:
    token = co["ats_token"]
    require_robots(c, f"https://{token}.bamboohr.com", "/careers/list", token)
    r = c.get(LIST_URL.format(token=token), headers={"Accept": "application/json"})
    r.raise_for_status()
    items = parse_bamboohr(r.json(), co, token)
    for it in [i for i in items if any(maybe_in_region(l) for l in i["locations"])][:MAX_DETAIL]:
        try:
            d = c.get(DETAIL_URL.format(token=token, id=it["_bh_id"]), headers={"Accept": "application/json"})
            if d.status_code == 200:
                job = (d.json().get("result") or {}).get("jobOpening") or {}
                it["description"] = html_to_text(job.get("description"))[:4000]
                it["posted_at"] = job.get("datePosted") or it["posted_at"]
        except Exception:
            pass
    for it in items:
        it.pop("_bh_id", None)
    return items
