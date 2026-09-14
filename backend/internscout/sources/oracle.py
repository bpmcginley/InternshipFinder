"""Oracle Recruiting Cloud (HCM) candidate-experience API. Token: "host|site",
e.g. "jpmc.fa.oraclecloud.com|CX_1001". Searched server-side for "intern"."""
from __future__ import annotations
from .common import board_item
from ..classify import is_internship

API = ("https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true"
       "&expand=requisitionList.secondaryLocations"
       "&finder=findReqs;siteNumber={site},keyword=intern,limit={limit},offset={offset},sortBy=POSTING_DATES_DESC")
JOB_URL = "https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{id}"
PAGE, MAX_OFFSET = 100, 600


def parse_oracle(payload: dict, co: dict, host: str, site: str) -> tuple[list[dict], int]:
    items = payload.get("items") or []
    head = items[0] if items else {}
    out = []
    for r in head.get("requisitionList") or []:
        title = r.get("Title", "")
        if not is_internship(title):
            continue
        sec = r.get("secondaryLocations") or []
        places = [(r.get("PrimaryLocation"), r.get("PrimaryLocationCountry"))] + [(s.get("Name"), s.get("CountryCode")) for s in sec]
        locs = [n.replace(", United States", "") for n, cc in places if n and cc == "US"]
        if not locs:
            continue
        out.append(board_item(co, source="oracle", title=title, locations=locs,
                              url=JOB_URL.format(host=host, site=site, id=r.get("Id")),
                              posted_at=r.get("PostedDate"), description=r.get("ShortDescriptionStr") or ""))
    return out, int(head.get("TotalJobsCount") or 0)


def fetch_oracle_board(c, co: dict) -> list[dict]:
    host, site = co["ats_token"].split("|", 1)
    out, offset = [], 0
    while offset < MAX_OFFSET:
        r = c.get(API.format(host=host, site=site, limit=PAGE, offset=offset))
        r.raise_for_status()
        items, total = parse_oracle(r.json(), co, host, site)
        out += items
        offset += PAGE
        if offset >= total:
            break
    return out
