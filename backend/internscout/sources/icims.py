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
# Tenants label this either "Job Locations" in a plain span (Midland) or "Location" inside the
# header-field block (NYU), where the value sits past a </dt><dd> boundary. Both put it in the
# next span. Bounded to 200 chars so a tenant we have not seen cannot swallow half the card.
LOC_RE = re.compile(r'field-label">\s*(?:Job\s+)?Locations?\s*</span>.{0,200}?<span[^>]*>(.*?)</span>', re.S | re.I)
DESC_RE = re.compile(r'class="[^"]*description[^"]*"[^>]*>(.*?)</div>', re.S | re.I)
ID_RE = re.compile(r"/jobs/(\d+)/")
# A tenant that has left iCIMS still answers 200, with a body that is nothing but a JS hop to the
# new board (Yale New Haven now does this). That parses to zero items and looks exactly like an
# employer with no internships, so we raise instead: scan_boards then records the board as failed
# and the stale token shows up in the run summary rather than hiding as a quiet zero.
MOVED_RE = re.compile(r"window\.top\.location\.href\s*=\s*'([^']+)'", re.I)
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
            moved = MOVED_RE.search(r.text) if len(r.text) < 2000 else None
            if moved:
                raise ValueError(f"icims tenant {token!r} has moved to {moved.group(1).replace(chr(92), '')}")
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
