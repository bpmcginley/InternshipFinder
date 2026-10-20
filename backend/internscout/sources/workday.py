"""Workday career sites via the CXS JSON API (the same calls the site's own UI makes).

Token: "tenant|wdN|site", e.g. "modernatx|wd1|M_tx". Workday serves the same boards from a
second domain, where the tenant is a path segment rather than a subdomain; those tokens carry
that domain in the middle field: "wf|wd1.myworkdaysite.com|WellsFargoJobs".
"""
from __future__ import annotations
import os
import re
from datetime import datetime, timedelta, timezone
from .common import (RobotsDisallowed, ScanCounts, board_item, counts_of, html_to_text,
                     mark_complete, reported_count, rows_of)
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


def board_locations(tenant: str, locations: list[str]) -> list[str]:
    """Expand verified employer campus labels before a state-code parser sees them.

    UT Austin's 'UT MAIN CAMPUS' means Austin, Texas, not Utah. This alias belongs
    only to that employer: a general 'UT' replacement would corrupt Utah roles.
    See https://www.utexas.edu/about-texas for the university's campus location.
    """
    return ["Austin, TX" if tenant.lower() == "utaustin" and
            " ".join(loc.upper().split()) == "UT MAIN CAMPUS" else loc for loc in locations]


# Hospitals rarely write "intern". Their student jobs are "Student Nurse Technician", "PACU
# Certified Nursing Assistant/ Nursing Student", "Apprentice Nurse Program", "Pathology Tech
# Student PD", and searchText="intern" never returns them. Nine Northeast health systems were
# seeded and the baseline states held one nursing listing. Checked live on 2026-09-18: a
# "student" search on Baystate, Beth Israel Lahey, Mass General Brigham and Brown Health turned up
# student roles that the "intern" search had missed. "extern" is no use, because Workday
# fuzzy-matches it to "external". The extra search runs only for these sectors, so other boards
# cost what they did before.
EXTRA_SEARCH = {"health": ("student",), "behavioral_health": ("student",)}
# Every board is searched for "intern". More words for every board are opt-in, comma separated:
# WORKDAY_EXTRA_KEYWORDS="co-op" restores the co-op search the October 16 expansion added.
# Measured on 2026-10-18 (docs/coverage-research/live-verification-2026-10-18.md), "co-op" added
# no accepted listing on three boards, because Workday's fuzzy "intern" search already returns
# most co-ops, while costing about 11 extra requests a board: about 13,500 requests and 9
# minutes a full run across 1,230 boards. "student" for every board found one more listing on
# Oshkosh ("Quality Intern (Summer 2027)") for about 4 more requests a board; it is not on by
# default either. Whatever words a run searches, completion means every one of them was read
# to its total (see _search).
BASE_SEARCH = ("intern",)
EXTRA_KEYWORDS_ENV = "WORKDAY_EXTRA_KEYWORDS"


def search_terms(sector: str | None = None) -> tuple[str, ...]:
    """The searchText values a board gets this run, in order, each once.

    "intern" always; then any words in WORKDAY_EXTRA_KEYWORDS; then the sector's own extra
    search (hospitals' "student"), which predates the expansion and stays on.
    """
    terms = list(BASE_SEARCH)
    for word in os.environ.get(EXTRA_KEYWORDS_ENV, "").split(","):
        word = " ".join(word.split()).lower()
        if word and word not in terms:
            terms.append(word)
    for word in EXTRA_SEARCH.get(sector, ()):
        if word not in terms:
            terms.append(word)
    return tuple(terms)


def _search(c, api: str, text: str, counts: ScanCounts | None = None) -> tuple[list[dict], bool]:
    """(internship postings, whether every result of this search was read).

    Complete means the first page reported a total, every page was a well-formed list, and the
    rows read add up to that total. Hitting MAX_OFFSET, stopping on DRY_PAGES of noise, or a page
    that came back short or empty before the total was reached all leave the search incomplete.
    """
    counts = counts if counts is not None else ScanCounts()
    postings, offset, total, dry = [], 0, None, 0
    reported, rows, well_formed, complete = None, 0, True, False
    while True:
        r = c.post(f"{api}/jobs", headers=HEADERS,
                   json={"appliedFacets": {}, "limit": PAGE, "offset": offset, "searchText": text})
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            raise ValueError("Workday search response is not an object")
        page = rows_of(data, "jobPostings")
        if page is None:
            well_formed, page = False, []
        if total is None:
            reported = reported_count(data.get("total"))
            counts.reported(reported)
            total = data.get("total") or 0   # only reported on the first page
        rows += len(page)
        counts.rows(len(page))
        found = parse_workday_list(data)
        counts.discard("not_student", max(0, len(page) - len(found)))
        postings += found
        dry = 0 if found else dry + 1
        offset += PAGE
        if not page or offset >= total or offset >= MAX_OFFSET:
            if page and offset < total:
                counts.stop("page_cap")
            complete = well_formed and reported is not None and rows == reported
            break
        if offset >= CORE_OFFSET and dry >= DRY_PAGES:
            counts.stop("dry_pages")
            break   # the matches have run out; the rest of this board is "internal" and "overseas"
    return postings, complete


def fetch_workday_board(c, co: dict) -> list[dict]:
    if not robots_allows(c, co["ats_token"]):
        raise RobotsDisallowed(co["ats_token"])
    host, tenant, site = host_of(co["ats_token"])
    api, base = f"{host}/wday/cxs/{tenant}/{site}", page_base(host, tenant, site)
    postings, seen, complete, counts = [], set(), True, counts_of(co)
    # "intern" finds most co-ops too (Workday's search is fuzzy); see search_terms for the words
    # that can be added. Keep the existing page/detail budgets and dedupe overlapping hits.
    for text in search_terms(co.get("sector")):
        found, whole = _search(c, api, text, counts)
        complete = complete and whole
        for p in found:
            key = p.get("externalPath") or p.get("title")
            if key not in seen:
                seen.add(key)
                postings.append(p)
            else:
                counts.discard("duplicate")

    out = []
    # The cap used to be "i < MAX_DETAIL": the posting's place in the list, not the calls made. On a
    # big board most of the first MAX_DETAIL postings are out of region and make no call, so the
    # budget went unspent while every "2 Locations" posting further down kept that text as its only
    # location and was dropped as unreadable. Now the calls themselves are counted, and a
    # multi-location posting, which is lost without its detail page, has a reserve of its own.
    calls = multi_calls = 0
    for i, p in enumerate(postings):
        path = p.get("externalPath") or ""
        url = f"{base}{path}"
        text = p.get("locationsText") or ""
        locs, desc = board_locations(tenant, [text]), ""
        multi = "location" in text.lower()   # "3 Locations"
        wanted = multi or any(maybe_in_region(loc) for loc in locs)
        if wanted and (calls < MAX_DETAIL or (multi and multi_calls < MAX_DETAIL)):
            calls += 1
            multi_calls += multi
            try:
                d = c.get(f"{api}{path}", headers=HEADERS)
                if d.status_code == 200:
                    dl, desc = parse_workday_detail(d.json())
                    locs = board_locations(tenant, dl) or locs
            except Exception:
                pass
        out.append(board_item(co, source="workday", title=p.get("title", ""), locations=locs,
                              url=url, description=desc,
                              posted_at=parse_posted_on(p.get("postedOn")),
                              employment_type=" ".join(p.get("bulletFields") or [])))
    # Every search this run made read to its reported total. The detail budget above trims descriptions, never
    # postings, so it does not affect this. The evidence covers what these searches return, not
    # the whole board: scan_evidence.SEARCH_SCOPED keeps that limit in view.
    mark_complete(co, complete)
    return out
