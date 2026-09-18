"""Oracle Recruiting Cloud (HCM) candidate-experience API. Token: "host|site",
e.g. "jpmc.fa.oraclecloud.com|CX_1001". Searched server-side for "intern".

The list payload has description fields on it, but on most tenants they are present and empty:
ShortDescriptionStr is an optional teaser an employer may never have filled in, and the two
External* fields only carry text on the requisition itself. Measured across the five tenants with
the most listings, 11 of 250 postings had any text on the list at all, which is why four in five
Oracle listings in the baseline states reached the dashboard with nothing to classify or read.

The requisition call fills them in. It is the same public API, needs no key, and answers in about
half a second. It is gated like Greenhouse's and Workday's - only for postings that might be
somewhere a student asked for, and capped per board - so at 16 boards in parallel even the worst
case, every one of the 122 tenants hitting the cap, is under two minutes.

CorporateDescriptionStr is left out for the same reason SmartRecruiters' companyDescription is:
it is the same employer boilerplate on every requisition, and it would crowd the real description
out of the 4,000-character budget and give the classifier marketing copy to tag a job by.
"""
from __future__ import annotations
from .common import board_item, html_to_text, require_robots
from ..classify import is_internship
from ..region import maybe_in_region

API = ("https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true"
       "&expand=requisitionList.secondaryLocations"
       "&finder=findReqs;siteNumber={site},keyword=intern,limit={limit},offset={offset},sortBy=POSTING_DATES_DESC")
# The id has to arrive quoted, and ById is the only finder this resource accepts - requisitionId,
# the name the docs use elsewhere, is rejected as an invalid finder rather than ignored.
DETAIL = ("https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true"
          "&expand=all&finder=ById;Id=%22{id}%22,siteNumber={site}")
JOB_URL = "https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{id}"
PAGE, MAX_OFFSET = 100, 600
MAX_DETAIL = 25
# What the job is, what you would do, what you need: the order an advert is written in.
FIELDS = ("ExternalDescriptionStr", "ExternalResponsibilitiesStr", "ExternalQualificationsStr")


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
        it = board_item(co, source="oracle", title=title, locations=locs,
                        url=JOB_URL.format(host=host, site=site, id=r.get("Id")),
                        posted_at=r.get("PostedDate"), description=r.get("ShortDescriptionStr") or "")
        it["_req_id"] = r.get("Id")
        out.append(it)
    return out, int(head.get("TotalJobsCount") or 0)


def parse_oracle_detail(payload: dict) -> str:
    """The requisition's own sections, in advert order, without the employer boilerplate."""
    it = (payload.get("items") or [{}])[0]
    parts = [html_to_text(it.get(k)) for k in FIELDS]
    return "\n".join(p for p in parts if p)


def fetch_oracle_board(c, co: dict) -> list[dict]:
    host, site = co["ats_token"].split("|", 1)
    require_robots(c, f"https://{host}",
                   "/hcmRestApi/resources/latest/recruitingCEJobRequisitions",
                   co["ats_token"])
    out, offset = [], 0
    while offset < MAX_OFFSET:
        r = c.get(API.format(host=host, site=site, limit=PAGE, offset=offset))
        r.raise_for_status()
        items, total = parse_oracle(r.json(), co, host, site)
        out += items
        offset += PAGE
        if offset >= total:
            break
    # A teaser the employer did bother to write is left alone; the call is for the ones with nothing.
    todo = [i for i in out if not (i["description"] or "").strip()
            and any(maybe_in_region(l) for l in i["locations"])]
    for it in todo[:MAX_DETAIL]:
        try:
            d = c.get(DETAIL.format(host=host, site=site, id=it["_req_id"]))
            if d.status_code == 200:
                it["description"] = parse_oracle_detail(d.json())[:4000]
        except Exception:
            pass
    return out
