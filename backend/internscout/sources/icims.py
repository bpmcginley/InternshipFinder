"""iCIMS career sites: the search page itself carries title, location, req id and a snippet.

Checked live 2026-09-15. Notes that cost time to learn:
  - The token is the WHOLE subdomain, not a company slug. Prefixes vary by tenant:
    hospital-midlandhealth, careers-uhnjcareers, jobs-selectmedicalcorp, encareers-cmh.
  - Job pages carry JSON-LD, but only a WebSite block. There is no JobPosting object, so a
    per-job call would buy nothing the search card does not already give us. We make none.
  - robots.txt allows /jobs/search; only referral, login, candidate and connect are disallowed.
  - `pr` is a 0-indexed page, 20 cards per page.
  - in_iframe=1 is load-bearing. Without it the same URL returns a different layout with no
    iCIMS_JobCardItem markup at all, and the parse silently yields nothing.

iCIMS is what most hospitals, health systems and universities run, which is where the
health, nursing and education listings live.
"""
from __future__ import annotations
import re
from .common import board_item, html_to_text
from ..classify import is_internship

SEARCH_URL = "https://{token}.icims.com/jobs/search"
# One unfiltered crawl would be hundreds of pages on a big health system. Searching a few
# student-shaped words instead keeps it to a handful of requests, then we dedupe by job id.
KEYWORDS = ("intern", "co-op", "student", "fellow")
MAX_PAGES = 5

CARD_RE = re.compile(r'<li[^>]*class="[^"]*iCIMS_JobCardItem[^"]*"[^>]*>(.*?)</li>', re.S | re.I)
LINK_RE = re.compile(r'<a\s+href="([^"]+)"[^>]*class="[^"]*iCIMS_Anchor', re.S | re.I)
TITLE_RE = re.compile(r"<h3[^>]*>(.*?)</h3>", re.S | re.I)
LOC_RE = re.compile(r"Job Locations</span>\s*<span[^>]*>(.*?)</span>", re.S | re.I)
DESC_RE = re.compile(r'class="[^"]*description[^"]*"[^>]*>(.*?)</div>', re.S | re.I)
ID_RE = re.compile(r"/jobs/(\d+)/")
# The card's additionalFields block is NOT a job type: which field a tenant puts there varies
# (Midland shows Requisition ID), and feeding a req number to stage_of() is worse than sending
# nothing. The title alone decides the stage here.


def _location(raw: str) -> list[str]:
    """'US-TX-Midland' -> ['Midland, TX']. Non-US rows are dropped, not translated."""
    out = []
    for chunk in html_to_text(raw).split("|"):
        parts = [p.strip() for p in chunk.strip().split("-") if p.strip()]
        if not parts or parts[0].upper() != "US":
            continue
        if len(parts) == 1:
            out.append("United States")
        elif len(parts) == 2:
            out.append("Remote - US" if parts[1].lower() == "remote" else parts[1])
        else:
            out.append(f"{'-'.join(parts[2:])}, {parts[1]}")
    return out


def parse_icims(html: str, co: dict) -> list[dict]:
    out = []
    for card in CARD_RE.findall(html or ""):
        link = LINK_RE.search(card)
        title = html_to_text(TITLE_RE.search(card).group(1)) if TITLE_RE.search(card) else ""
        if not link or not is_internship(title, ""):
            continue
        locs = _location(LOC_RE.search(card).group(1)) if LOC_RE.search(card) else []
        if not locs:
            continue
        url = html_to_text(link.group(1)).replace("&amp;", "&")
        url = re.sub(r"[?&]in_iframe=1", "", url)
        desc = html_to_text(DESC_RE.search(card).group(1)) if DESC_RE.search(card) else ""
        out.append(board_item(co, source="icims", title=title, locations=locs, url=url,
                              description=desc))
    return out


def fetch_icims_board(c, co: dict) -> list[dict]:
    token, seen, items = co["ats_token"], set(), []
    for kw in KEYWORDS:
        for page in range(MAX_PAGES):
            r = c.get(SEARCH_URL.format(token=token),
                      params={"ss": 1, "searchKeyword": kw, "pr": page, "in_iframe": 1})
            r.raise_for_status()
            found = parse_icims(r.text, co)
            if not found:
                break
            for it in found:
                m = ID_RE.search(it["url"] or "")
                key = m.group(1) if m else it["url"]
                if key not in seen:
                    seen.add(key)
                    items.append(it)
            # A short page is the last page; iCIMS serves 20 cards when there are more.
            if len(CARD_RE.findall(r.text)) < 20:
                break
    return items
