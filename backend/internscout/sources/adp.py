"""ADP Workforce Now public career centers (small/mid employers, schools). Token: the career
center's cid, e.g. "89da4960-4d45-4b46-b7aa-5959c5f71827". The list has no descriptions, so
in-region internships get one detail call each (capped)."""
from __future__ import annotations
from .common import board_item, html_to_text
from ..classify import is_internship
from ..region import maybe_in_region

API = "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions"
JOB_URL = ("https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"
           "?cid={cid}&ccId=19000101_000001&jobId={job}&lang=en_US")
PARAMS = {"lang": "en_US", "locale": "en_US", "ccId": "19000101_000001"}
PAGE, MAX_SKIP, MAX_DETAIL = 100, 1000, 25


def _locations(r: dict) -> list[str]:
    out = []
    for loc in r.get("requisitionLocations") or []:
        a = loc.get("address") or {}
        name = ((loc.get("nameCode") or {}).get("shortName") or "").strip()
        country = (a.get("countryCode") or "").upper()
        st = ((a.get("countrySubdivisionLevel1") or {}).get("codeValue") or "").strip()
        if name.endswith((", US", ", USA")):
            country = country or "US"
        if country and country != "US":
            continue
        if a.get("cityName") and st:
            out.append(f"{a['cityName']}, {st}")
        elif "remote" in name.lower():
            out.append("Remote - US")
        elif st:
            out.append(st)
    return out


def _string_field(r: dict, code: str) -> str | None:
    for f in (r.get("customFieldGroup") or {}).get("stringFields") or []:
        if (f.get("nameCode") or {}).get("codeValue") == code:
            return f.get("stringValue")
    return None


def parse_adp(payload: dict, co: dict, cid: str) -> tuple[list[dict], int]:
    out = []
    for r in payload.get("jobRequisitions") or []:
        title = r.get("requisitionTitle") or ""
        emp = (r.get("workLevelCode") or {}).get("shortName") or ""
        if not is_internship(title, emp):
            continue
        locs = _locations(r)
        if not locs:
            continue
        job = _string_field(r, "ExternalJobID")
        url = JOB_URL.format(cid=cid, job=job) if job else \
            f"https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid={cid}"
        it = board_item(co, source="adp", title=title, locations=locs, url=url,
                        posted_at=r.get("postDate"), employment_type=emp)
        it["_adp_id"] = r.get("itemID")
        out.append(it)
    return out, int((payload.get("meta") or {}).get("totalNumber") or 0)


def fetch_adp_board(c, co: dict) -> list[dict]:
    cid = co["ats_token"]
    out, skip = [], 0
    while skip < MAX_SKIP:
        r = c.get(API, params={"cid": cid, **PARAMS, "$top": PAGE, "$skip": skip})
        r.raise_for_status()
        items, total = parse_adp(r.json(), co, cid)
        out += items
        skip += PAGE
        if skip >= total:
            break
    n = 0
    for it in out:
        if n >= MAX_DETAIL or not any(maybe_in_region(l) for l in it["locations"]):
            continue
        n += 1
        try:
            d = c.get(f"{API}/{it['_adp_id']}", params={"cid": cid, **PARAMS})
            if d.status_code == 200:
                it["description"] = html_to_text(d.json().get("requisitionDescription"))[:4000]
        except Exception:
            pass
    return out
