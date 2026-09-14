"""BambooHR careers JSON: <slug>.bamboohr.com/careers/list, with a detail call for descriptions."""
from __future__ import annotations
from .common import board_item, html_to_text
from ..classify import is_internship
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
        loc = j.get("atsLocation") or j.get("location") or {}
        if (loc.get("country") or "").strip().lower() not in _US:
            continue
        names = [", ".join(x for x in (loc.get("city"), loc.get("state") or loc.get("province")) if x)]
        if j.get("isRemote"):
            names.append("Remote - US")
        it = board_item(co, source="bamboohr", title=title, locations=names,
                        url=f"https://{token}.bamboohr.com/careers/{j.get('id')}", employment_type=emp)
        it["_bh_id"] = j.get("id")
        out.append(it)
    return out


def fetch_bamboohr_board(c, co: dict) -> list[dict]:
    token = co["ats_token"]
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
