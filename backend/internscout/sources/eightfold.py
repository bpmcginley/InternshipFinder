"""Eightfold career sites (<tenant>.eightfold.ai) via the search API their own page calls.

Checked live 2026-09-17 against John Deere, Eaton, Boston Scientific and PayPal. What it is worth
knowing before touching this:
  - robots.txt disallows the site and then allows a short list back, /api/pcsx among them, which is
    the endpoint used here. /api/apply/v2/jobs, the older public one, answers 403 "Not authorized
    for PCSX" on every tenant checked, so it is not an alternative.
  - The `domain` parameter is required: without it the API answers 422. It is the employer's own
    website, not the career host - johndeere.com, not johndeere.eightfold.ai - and it is not
    derivable from the tenant in general, so a token may carry it after a pipe. Where it does not,
    <tenant>.com is assumed, which held for all four tenants checked.
  - The page size is fixed at 10. `num` is accepted and ignored, so paging is start=0, 10, 20...
    and `count` in the response is the real total.
  - Locations come twice: `locations` in whatever the employer typed ('Various Locations,Illinois,
    United States', 'Moon Township, Pennsylvania, USA, 15108') and `standardizedLocations` in one
    consistent shape ('Pinckneyville, IL, US', and sometimes just 'IL,US' when the employer gave no
    city). The standardized one is what we read; the arrays are parallel and a job can hold several.
  - There is no description in the payload and no detail endpoint under the allowed paths, so
    neither a description nor a snippet is reported.
"""
from __future__ import annotations
from .common import board_item, require_robots
from ..classify import is_internship
from ..geo import STATE_NAMES

SEARCH_URL = "https://{tenant}.eightfold.ai/api/pcsx/search"
JOB_URL = "https://{tenant}.eightfold.ai/careers/job/{id}"
# The search is a relevance search, not a filter, so it answers "intern" with anything it thinks is
# close (PayPal's top hit for it is a Manager of Internal Controls). is_internship sorts that out;
# the words are here only to keep us from crawling an employer's whole board.
KEYWORDS = ("intern", "co-op", "student", "graduate program")
PAGE_SIZE = 10
MAX_PAGES = 12

US_STATES = set(STATE_NAMES.values())


def host_of(token: str) -> tuple[str, str]:
    """'johndeere' -> ('johndeere', 'johndeere.com'); 'wf|wellsfargo.com' keeps the given domain."""
    tenant, _, domain = token.partition("|")
    return tenant, domain or f"{tenant}.com"


def _locations(std: list) -> list[str]:
    """['Moline, IL, US', 'Slough, England, GB'] -> ['Moline, IL']. Non-US entries are dropped."""
    out = []
    for entry in std or []:
        parts = [p.strip() for p in str(entry).split(",") if p.strip()]
        if len(parts) < 2 or parts[-1].upper() not in ("US", "USA"):
            continue
        st = parts[-2].upper()
        if st not in US_STATES:
            continue
        # Two parts is 'IL,US': the employer named a state and no city, which the state labeler can
        # still place. Anything longer is city first, however many commas the city itself contains.
        place = st if len(parts) == 2 else f"{', '.join(parts[:-2])}, {st}"
        if place not in out:
            out.append(place)
    return out


def parse_eightfold(payload: dict, co: dict) -> list[dict]:
    tenant, _ = host_of(co["ats_token"])
    out = []
    for p in ((payload or {}).get("data") or {}).get("positions") or []:
        title = p.get("name") or ""
        if not is_internship(title, p.get("department") or ""):
            continue
        locs = _locations(p.get("standardizedLocations"))
        if not locs:
            continue
        # positionUrl is site-relative ('/careers/job/137482769212'); build the same link from the
        # id when it is missing, which is the form every tenant checked serves.
        path = p.get("positionUrl") or ""
        url = (f"https://{tenant}.eightfold.ai{path}" if path.startswith("/")
               else path or JOB_URL.format(tenant=tenant, id=p.get("id")))
        out.append(board_item(co, source="eightfold", title=title, locations=locs, url=url,
                              posted_at=p.get("postedTs") or None,
                              employment_type=p.get("workLocationOption") or ""))
    return out


def fetch_eightfold_board(c, co: dict) -> list[dict]:
    tenant, domain = host_of(co["ats_token"])
    require_robots(c, f"https://{tenant}.eightfold.ai", "/api/pcsx/search",
                   co["ats_token"])
    seen, items = set(), []
    for kw in KEYWORDS:
        for page in range(MAX_PAGES):
            r = c.get(SEARCH_URL.format(tenant=tenant),
                      params={"domain": domain, "query": kw, "start": page * PAGE_SIZE,
                              "num": PAGE_SIZE})
            # 422 means the domain guess was wrong, which is worth raising rather than reading as
            # an employer with no internships: scan_boards then reports the board as failed and the
            # token shows up in the run summary asking for its real domain.
            r.raise_for_status()
            payload = r.json()
            data = payload.get("data") or {}
            got = data.get("positions") or []
            for it in parse_eightfold(payload, co):
                if it["url"] not in seen:
                    seen.add(it["url"])
                    items.append(it)
            if len(got) < PAGE_SIZE or (page + 1) * PAGE_SIZE >= (data.get("count") or 0):
                break
    return items
