"""SAP SuccessFactors career sites: the /search/ page carries title, location and job id.

Checked live 2026-09-17 against Qorvo, Corning and Southern California Edison. Notes that cost
time to learn:
  - The token is the WHOLE host, not a company slug, and it is rarely the company's own domain:
    careers.qorvo.com, corningjobs.corning.com, apply.edisoncareers.com.
  - robots.txt (identical on every tenant checked) disallows /services/, so the JSON endpoint
    behind the page is off limits. /search/ and /sitemap.xml are allowed, and the search page
    already carries everything a listing needs, so we read that.
  - 25 jobs a page, paged with startrow=25, 50, 75...
  - Two templates in the wild. Qorvo and Corning use a table: one <tr class="data-row"> per job,
    with the location in a <span class="jobLocation">. Edison uses tiles, with no location markup
    anywhere on the page - the state is only in the URL slug. Both repeat the same job's link two
    or three times over (desktop, tablet, phone), so every link is keyed by job id and the first
    location found for that id wins.
  - There is no posting date and no snippet on either template, so neither is reported.

SuccessFactors is what large hospitals, universities, utilities and manufacturers run, which is
where the health, education and energy listings live.
"""
from __future__ import annotations
import re
from .common import board_item, html_to_text
from ..classify import is_internship

SEARCH_URL = "https://{token}/search/"
# One unfiltered crawl would be the employer's whole board. Searching a few student-shaped words
# instead keeps it to a handful of requests, then we dedupe by job id.
KEYWORDS = ("intern", "co-op", "student", "fellow")
MAX_PAGES = 5
PAGE_SIZE = 25

# The class can come before or after the href, so the tag's attributes are captured whole and the
# href is picked out of them afterwards.
ANCHOR_RE = re.compile(r"<a\s([^>]*jobTitle-link[^>]*)>(.*?)</a>", re.S | re.I)
HREF_RE = re.compile(r'href="([^"]+)"', re.I)
JOB_RE = re.compile(r"/job/([^/\"]+)/(\d+)/")
# Only a <span>: the column header is an <a class="jobLocation sort"> and is not a job's location.
LOC_RE = re.compile(r'<span[^>]*class="[^"]*jobLocation[^"]*"[^>]*>(.*?)</span>', re.S | re.I)
# 'Rosemead-2027-Summer-Internship-MBA-%28Rosemead%29-CA-91770-3714' -> CA. The city is in there
# too, as the first segment, but a hyphenated one (Winston-Salem) cannot be told from a city
# followed by the start of the title, and a wrong city is worse to show than no city at all.
SLUG_ST_RE = re.compile(r"-([A-Z]{2})-\d{5}(?:-\d{4})?$")
COUNTRY_US = {"US", "USA", "UNITED STATES"}


def _location(raw: str, slug: str) -> list[str]:
    """'Greensboro, NC, US, 27409' -> ['Greensboro, NC']. Non-US rows are dropped, not translated."""
    parts = [p.strip() for p in html_to_text(raw).split(",") if p.strip()]
    up = [p.upper() for p in parts]
    if parts:
        if not COUNTRY_US & set(up):
            return []
        # Everything past the country code is the postcode, which we do not want.
        head = parts[:next(i for i, p in enumerate(up) if p in COUNTRY_US)]
        if not head:
            return ["United States"]
        if len(head) == 1:
            return ["Remote - US" if head[0].lower().startswith("remote") else head[0]]
        return [f"{head[-2]}, {head[-1]}"]
    # A tile-layout tenant prints no location at all, so fall back to the slug's state.
    m = SLUG_ST_RE.search(slug)
    return [m.group(1)] if m else []


def parse_successfactors(html: str, co: dict) -> list[dict]:
    host, by_id = co["ats_token"], {}
    anchors = list(ANCHOR_RE.finditer(html or ""))
    for n, a in enumerate(anchors):
        href = HREF_RE.search(a.group(1))
        job = JOB_RE.search(href.group(1)) if href else None
        if not job:
            continue
        # A job's location sits after its link and before the next one, wherever the template puts
        # it. Some of a job's repeated links have it and some do not, so the first one found wins.
        # Bounded as well as bracketed, so the last job on the page cannot reach into the footer.
        end = anchors[n + 1].start() if n + 1 < len(anchors) else len(html)
        after = html[a.end():min(end, a.end() + 3000)]
        loc = LOC_RE.search(after)
        rec = by_id.setdefault(job.group(2), {"title": html_to_text(a.group(2)),
                                              "href": html_to_text(href.group(1)).replace("&amp;", "&"),
                                              "slug": job.group(1), "raw": ""})
        if loc and not rec["raw"]:
            rec["raw"] = loc.group(1)
    out = []
    for rec in by_id.values():
        if not is_internship(rec["title"], ""):
            continue
        locs = _location(rec["raw"], rec["slug"])
        if not locs:
            continue
        out.append(board_item(co, source="successfactors", title=rec["title"], locations=locs,
                              url=f"https://{host}{rec['href']}"))
    return out


def fetch_successfactors_board(c, co: dict) -> list[dict]:
    token, seen, items = co["ats_token"], set(), []
    for kw in KEYWORDS:
        for page in range(MAX_PAGES):
            r = c.get(SEARCH_URL.format(token=token), params={"q": kw, "startrow": page * PAGE_SIZE})
            r.raise_for_status()
            # A tenant that has left SuccessFactors still answers 200, with a body that is empty or
            # a stub (Aramark now serves nothing at all). That parses to zero items and looks
            # exactly like an employer with no internships, so we raise instead: scan_boards then
            # records the board as failed and the stale token shows up in the run summary rather
            # than hiding as a quiet zero. A live board with no matches is a full 60 KB page.
            if len(r.text) < 2000:
                raise ValueError(f"successfactors tenant {token!r} served no career site")
            for it in parse_successfactors(r.text, co):
                m = JOB_RE.search(it["url"] or "")
                key = m.group(2) if m else it["url"]
                if key not in seen:
                    seen.add(key)
                    items.append(it)
            # A short page is the last page; SuccessFactors serves 25 links when there are more.
            if len({m.group(2) for m in JOB_RE.finditer(r.text)}) < PAGE_SIZE:
                break
    return items
