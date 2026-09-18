"""iCIMS Career Sites: the employer's own host in front of an iCIMS tenant.

careers.amd.com, jobs.statefarm.com, careers.jhuapl.edu. The apply link ends in "?icims=1" but the
host is the employer's, so nothing about these boards looks like iCIMS until you ask them. The
/jobs/search portal icims.py reads is not served here - it answers 404, or a search page carrying no
job markup - because these run the other product, the one iCIMS bought with Jibe. What they do serve
is JSON at /api/jobs, and it carries more than the portal does: title, the whole description,
city and state, the posting date and the apply URL, all in one call, so there is no per-job pass
here at all.

Checked live 2026-09-18 on all 29 branded hosts already in the data. Every one answered. Also:
  - robots.txt is "Allow: /" with crawl-delay 5 on every host checked, which is why the pages are
    spaced out rather than fetched one after another.
  - limit is capped at 100 - 500 is a 422 - and page is 1-indexed.
  - keywords searches the description as well as the title, so a bare "student" matched 2,916 jobs
    at one health system where dropping it left 194, for the same internships. Hence the narrow
    query below; is_internship still makes the decision, on the title and the employment type.
  - A posting outside the US has no state at all, which is why the country code is what the filter
    reads. additional_locations carries the other sites of a multi-location posting.
"""
from __future__ import annotations
import re
import time

from .common import board_item, html_to_text
from ..classify import is_internship

URL = "https://{token}/api/jobs"
JOB_URL = "https://{token}/jobs/{slug}"
QUERY = "intern OR internship OR co-op OR fellow"
LIMIT = 100        # the API's own ceiling
MAX_PAGES = 3
CRAWL_DELAY = 5    # what these hosts ask for in robots.txt
# 'posted_date' is a full timestamp; the day is all that is wanted here.
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _locations(d: dict) -> list[str]:
    """'Laurel, Maryland' for every US site of a posting. A posting with none is not ours."""
    out = []
    for p in [d] + list(d.get("additional_locations") or []):
        if (p.get("country_code") or "").upper() != "US":
            continue
        name = ", ".join(x for x in (p.get("city"), p.get("state")) if x)
        if name and name not in out:
            out.append(name)
    return out


def parse_icims_site(payload: dict, co: dict) -> list[dict]:
    out = []
    for j in (payload or {}).get("jobs") or []:
        d = j.get("data") or {}
        title = d.get("title") or ""
        emp = (d.get("employment_type") or "").replace("_", " ")
        if not is_internship(title, emp):
            continue
        locs = _locations(d)
        if not locs:
            continue
        day = DATE_RE.match(str(d.get("posted_date") or ""))
        out.append(board_item(co, source="icims_site", title=title, locations=locs,
                              url=JOB_URL.format(token=co["ats_token"], slug=d.get("slug")),
                              posted_at=day.group(1) if day else None,
                              description=html_to_text(d.get("description")),
                              employment_type=emp))
    return out


def fetch_icims_site_board(c, co: dict) -> list[dict]:
    token = co["ats_token"]
    seen: dict[str, dict] = {}
    for page in range(1, MAX_PAGES + 1):
        if page > 1:
            time.sleep(CRAWL_DELAY)
        r = c.get(URL.format(token=token), params={"keywords": QUERY, "limit": LIMIT, "page": page},
                  headers={"Accept": "application/json"})
        r.raise_for_status()
        payload = r.json()
        for it in parse_icims_site(payload, co):
            seen[it["url"]] = it
        if page * LIMIT >= (payload.get("totalCount") or 0):
            break
    return list(seen.values())
