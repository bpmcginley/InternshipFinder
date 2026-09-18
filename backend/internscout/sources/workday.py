"""Workday career sites via the CXS JSON API (the same calls the site's own UI makes).

Token: "tenant|wdN|site", e.g. "modernatx|wd1|M_tx". Workday serves the same boards from a
second domain, where the tenant is a path segment rather than a subdomain; those tokens carry
that domain in the middle field: "wf|wd1.myworkdaysite.com|WellsFargoJobs".
"""
from __future__ import annotations
import re
from datetime import datetime, timedelta, timezone
from .common import RobotsDisallowed, board_item, html_to_text
from .common import robots_allows as _host_allows
from ..classify import is_internship
from ..region import maybe_in_region

PAGE = 20
# How far into a board's results we read. searchText="intern" is a fuzzy match - "internal",
# "international" - so the tail of a large board is mostly noise, but not all of it: sampling 39
# boards, 9 hold more than 200 results, and Oshkosh alone had 53 internships past that mark
# against 75 before it. Past CORE_OFFSET we keep reading until three pages in a row hold no
# internship at all, which stops on the noise without cutting a board whose matches are spread out.
CORE_OFFSET = 200
MAX_OFFSET = 400
DRY_PAGES = 3
MAX_DETAIL = 40
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def robots_allows(c, token: str) -> bool:
    """Whether a Workday tenant lets us read this board.

    Workday gives every tenant its own host and its own robots.txt, and tenants use it. Of the
    1,245 boards in the registry, 109 are closed by name by the host serving them:

        User-agent: *
        Allow: /BlackRock_Professional/
        Disallow: /BlackRock_AIG/
        Disallow: /BlackRock_Early_Careers_Program/
        Disallow: /refreshFacet/

    The names say what most of them are: Mizuho_Confidential, Public_Posting_Site,
    only_confidential_executive_recruiting, Employee_Referral_Portal, sourcer_on_req,
    redeploymentmedtroniccareers. The rest are ordinary careers sites whose employer would rather
    aggregators stayed off them - Nike, Xylem and Thermo Fisher each close their main board. Either
    way it is the employer saying so, which is the rule that already kept UKG and the NSF REU list
    out of this project.

    The answer is read per site, not per host, because a host serves several boards and answers
    differently for them, as BlackRock does above; common.robots_allows caches the file itself.

    The second Workday domain has no per-tenant robots.txt to read - there the tenant is a path
    segment on a host shared by every tenant on the pod, so the file is not the tenant's to write -
    and those 21 boards are read as before.
    """
    host, _tenant, site = host_of(token)
    if "myworkdaysite" in host:
        return True
    return _host_allows(c, host, f"/{site}/")


def host_of(token: str) -> tuple[str, str, str]:
    tenant, wd, site = token.split("|")
    if "." in wd:
        return f"https://{wd}", tenant, site
    return f"https://{tenant}.{wd}.myworkdayjobs.com", tenant, site


def page_base(host: str, tenant: str, site: str) -> str:
    """Where a student's link points. The two domains lay the path out differently."""
    return f"{host}/recruiting/{tenant}/{site}" if "myworkdaysite" in host else f"{host}/{site}"


_POSTED_RE = re.compile(r"posted\s+(?:(today)|(yesterday)|(\d{1,4})(\+?)\s+days?\s+ago)", re.I)


def parse_posted_on(text: str | None, today=None) -> str | None:
    """The date behind Workday's "Posted 18 Days Ago", or None when the board only gives a floor.

    Every posting in the list payload carries this string and we were dropping it, so 79% of the
    Workday listings in the last export had no posted date - the largest metadata gap in the corpus,
    and Workday is a third of it. Across 153 live postings the board said "N Days Ago" or
    "Yesterday" for 84% of them, which is an exact date.

    The rest say "30+ Days Ago", which is a floor and not a date: the posting is at least 30 days
    old and may be a year old. A stored date is printed on the card as "Posted Aug 19" and recomputed
    on the next run, where a floor would slide forward a day at a time and the job would look
    permanently a month old. No date is honest about what the board told us; a wrong one is not.
    """
    m = _POSTED_RE.search(text or "")
    if not m:
        return None
    day = today or datetime.now(timezone.utc).date()
    if m.group(1):
        return day.isoformat()
    if m.group(2):
        return (day - timedelta(days=1)).isoformat()
    if m.group(4):
        return None
    return (day - timedelta(days=int(m.group(3)))).isoformat()


def parse_workday_list(payload: dict) -> list[dict]:
    return [p for p in payload.get("jobPostings") or [] if is_internship(p.get("title", ""))]


def parse_workday_detail(payload: dict) -> tuple[list[str], str]:
    info = payload.get("jobPostingInfo") or {}
    locs = [info.get("location")] + list(info.get("additionalLocations") or [])
    return [l for l in locs if l], html_to_text(info.get("jobDescription"))


def fetch_workday_board(c, co: dict) -> list[dict]:
    if not robots_allows(c, co["ats_token"]):
        raise RobotsDisallowed(co["ats_token"])
    host, tenant, site = host_of(co["ats_token"])
    api, base = f"{host}/wday/cxs/{tenant}/{site}", page_base(host, tenant, site)
    postings, offset, total, dry = [], 0, None, 0
    while True:
        r = c.post(f"{api}/jobs", headers=HEADERS,
                   json={"appliedFacets": {}, "limit": PAGE, "offset": offset, "searchText": "intern"})
        r.raise_for_status()
        data = r.json()
        page = data.get("jobPostings") or []
        if total is None:
            total = data.get("total") or 0   # only reported on the first page
        found = parse_workday_list(data)
        postings += found
        dry = 0 if found else dry + 1
        offset += PAGE
        if not page or offset >= total or offset >= MAX_OFFSET:
            break
        if offset >= CORE_OFFSET and dry >= DRY_PAGES:
            break   # the matches have run out; the rest of this board is "internal" and "overseas"

    out = []
    for i, p in enumerate(postings):
        path = p.get("externalPath") or ""
        url = f"{base}{path}"
        text = p.get("locationsText") or ""
        locs, desc = [text], ""
        multi = "location" in text.lower()   # "3 Locations"
        if i < MAX_DETAIL and (multi or maybe_in_region(text)):
            try:
                d = c.get(f"{api}{path}", headers=HEADERS)
                if d.status_code == 200:
                    dl, desc = parse_workday_detail(d.json())
                    locs = dl or locs
            except Exception:
                pass
        out.append(board_item(co, source="workday", title=p.get("title", ""), locations=locs,
                              url=url, description=desc,
                              posted_at=parse_posted_on(p.get("postedOn")),
                              employment_type=" ".join(p.get("bulletFields") or [])))
    return out
