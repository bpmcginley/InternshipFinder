"""Oracle Recruiting Cloud (HCM) candidate-experience API. Token: "host|site",
e.g. "jpmc.fa.oraclecloud.com|CX_1001". Searched server-side for student-role terms.

The list payload has description fields on it, but on most tenants they are present and empty:
ShortDescriptionStr is an optional teaser an employer may never have filled in, and the two
External* fields only carry text on the requisition itself. Measured across the five tenants with
the most listings, 11 of 250 postings had any text on the list at all, which is why four in five
Oracle listings in the baseline states reached the dashboard with nothing to classify or read.

The requisition call fills them in. It is the same public API and needs no key. It is gated like
Greenhouse's and Workday's - only for postings that might be somewhere a student asked for, and
capped per board. Query expansion does not increase that detail-call cap.

CorporateDescriptionStr is left out for the same reason SmartRecruiters' companyDescription is:
it is the same employer boilerplate on every requisition, and it would crowd the real description
out of the 4,000-character budget and give the classifier marketing copy to tag a job by.
"""
from __future__ import annotations
from .common import (board_item, counts_of, html_to_text, mark_complete, reported_count,
                     require_robots, rows_of)
from ..classify import is_internship
from ..region import maybe_in_region

API = ("https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true"
       "&expand=requisitionList.secondaryLocations"
       "&finder=findReqs;siteNumber={site},keyword={keyword},limit={limit},offset={offset},sortBy=POSTING_DATES_DESC")
# Separate searches avoid losing co-ops and student jobs behind noisy "intern" results. A bounded
# Stantec check on 2026-10-16 returned 802 "intern" matches (over our 600-result cap), versus 104
# "co-op" and 112 "student" matches. French stagiaire titles are accepted by the classifier too.
# Keep the per-keyword pagination cap and deduplicate requisition IDs across all four searches.
KEYWORDS = ("intern", "co-op", "student", "stagiaire")
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
    out, counts = [], counts_of(co)
    for r in head.get("requisitionList") or []:
        title = r.get("Title", "")
        if not is_internship(title):
            counts.discard("not_student")
            continue
        sec = r.get("secondaryLocations") or []
        places = [(r.get("PrimaryLocation"), r.get("PrimaryLocationCountry"))] + [(s.get("Name"), s.get("CountryCode")) for s in sec]
        locs = []
        for name, country in places:
            if not name:
                continue
            if country == "US":
                locs.append(name.replace(", United States", ""))
            elif country == "CA":
                # The explicit country prevents ambiguous names (London, Victoria) and
                # the ISO country code CA from being interpreted as US locations.
                locs.append(name if "canada" in name.lower() else f"{name}, Canada")
        if not locs:
            counts.discard("outside_region")
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
    out, seen, complete, counts = [], set(), True, counts_of(co)
    for keyword in KEYWORDS:
        offset, reported, rows, well_formed = 0, None, 0, True
        while offset < MAX_OFFSET:
            r = c.get(API.format(host=host, site=site, keyword=keyword, limit=PAGE, offset=offset))
            r.raise_for_status()
            payload = r.json()
            if not isinstance(payload, dict):
                raise ValueError("Oracle search response is not an object")
            heads = payload.get("items")
            page = rows_of(heads[0], "requisitionList") if isinstance(heads, list) and heads else None
            if page is None:
                well_formed = False
            elif offset == 0:
                reported = reported_count(heads[0].get("TotalJobsCount"))
            if offset == 0:
                counts.reported(reported)
            rows += len(page or [])
            counts.rows(len(page or []))
            items, total = parse_oracle(payload, co, host, site)
            for it in items:
                if it["_req_id"] not in seen:
                    seen.add(it["_req_id"])
                    out.append(it)
                else:
                    counts.discard("duplicate")
            offset += PAGE
            if offset >= total:
                break
        else:
            if offset < total:
                counts.stop("page_cap")   # MAX_OFFSET reached with matches left
        # A keyword whose matches run past MAX_OFFSET is read only in part, and so is the board.
        complete = complete and well_formed and reported is not None and rows == reported
    # A teaser the employer did bother to write is left alone; the call is for the ones with nothing.
    todo = [i for i in out if not (i["description"] or "").strip()
            and any(maybe_in_region(l) for l in i["locations"])]
    for it in todo[:MAX_DETAIL]:
        try:
            d = c.get(DETAIL.format(host=host, site=site, id=it["_req_id"]))
            if d.status_code == 200:
                # 2026-10-23: extract eligibility before public trimming; was: [:4000].
                # Revert: restore [:4000] here (DQ-1).
                it["description"] = parse_oracle_detail(d.json())
        except Exception:
            pass
    mark_complete(co, complete)   # every keyword read to its TotalJobsCount; see scan_evidence
    return out
