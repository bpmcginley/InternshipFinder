"""SmartRecruiters public postings API.

The list call carries no text at all - not even a snippet - so every SmartRecruiters listing
reached the dashboard with an empty description, and its field tags came from the title alone.
The per-posting call fills that in: it is free, needs no key, and answers in about a tenth of a
second. Like the other boards, it is spent only on postings that might be somewhere a student
asked for, and capped per board.

companyDescription is deliberately left out of the text we keep. It is the same paragraphs of
employer boilerplate on every posting a company has, and including it would both crowd out the
real description inside the 4,000-character budget and hand the classifier a company's marketing
copy to tag a job by.
"""
from __future__ import annotations
from .common import board_item, html_to_text, require_robots
from ..classify import is_internship
from ..region import maybe_in_region

URL = "https://api.smartrecruiters.com/v1/companies/{token}/postings"
JOB_URL = "https://api.smartrecruiters.com/v1/companies/{token}/postings/{id}"
MAX_OFFSET = 500
MAX_DETAIL = 25
# In posting order, so the description reads the way the advert does.
SECTIONS = ("jobDescription", "qualifications", "additionalInformation")


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
        it = board_item(co, source="smartrecruiters", title=title, locations=locs,
                        url=f"https://jobs.smartrecruiters.com/{token}/{j.get('id')}",
                        posted_at=j.get("releasedDate"), employment_type=emp)
        it["_sr_id"] = j.get("id")
        out.append(it)
    return out


def parse_smartrecruiters_detail(payload: dict) -> str:
    """The advert's own sections, in order, minus the employer boilerplate."""
    secs = ((payload.get("jobAd") or {}).get("sections")) or {}
    parts = [html_to_text((secs.get(k) or {}).get("text")) for k in SECTIONS]
    return "\n".join(p for p in parts if p)


def fetch_smartrecruiters_board(c, co: dict) -> list[dict]:
    token, out, offset = co["ats_token"], [], 0
    require_robots(c, "https://api.smartrecruiters.com", "/v1/companies/", token)
    while offset < MAX_OFFSET:
        r = c.get(URL.format(token=token), params={"q": "intern", "limit": 100, "offset": offset})
        r.raise_for_status()
        data = r.json()
        out += parse_smartrecruiters(data, co, token)
        offset += 100
        if offset >= (data.get("totalFound") or 0):
            break
    for it in [i for i in out if any(maybe_in_region(l) for l in i["locations"])][:MAX_DETAIL]:
        try:
            d = c.get(JOB_URL.format(token=token, id=it["_sr_id"]))
            if d.status_code == 200:
                it["description"] = parse_smartrecruiters_detail(d.json())[:4000]
        except Exception:
            pass
    return out
