"""JazzHR public boards (<tenant>.applytojob.com/apply).

Checked live 2026-09-17 against Nebo, Aramco Americas, ZGF Architects, Specialisterne, Innovation
Works, Stellar Science and ARM. Worth knowing before touching this:
  - robots.txt disallows only /cb, so /apply is fair game. There is no JSON API: /apply/jobs.json
    and friends answer 404, and /apply/feed is 410. The board page is the public interface.
  - The whole board is on that one page - no paging - so a board costs one request however big it is.
  - The markup is a flat <li class="list-group-item"> per job, holding the title link and an
    optional location and department. There is no date, and no description: that would cost one
    request per job, which is what the demand gate exists to avoid spending on boards this small.
  - The department is read but not kept. It is a team name ("Accounting and Finance"), not a
    description, so showing it as one would mislead; and as classifier input it was worth almost
    nothing - across 53 internships on six boards it rescued one listing from "other" and refined
    one more. The title already carries the field.
  - An employer with nothing open serves the page with no items at all rather than an empty-state
    message, so zero jobs is normal and not a failure.
  - The tenant is not always the company: neboagency is "Nebo". The board page names the employer in
    an Organization block, but the registry already has a name from wherever the board was
    discovered, so that is left alone and only used when a seed gave us nothing.
"""
from __future__ import annotations
import html
import json
import re

from .common import board_item, counts_of, html_to_text, require_robots
from ..classify import is_internship
from ..region import board_state, maybe_in_region, place_bare_cities

URL = "https://{tenant}.applytojob.com/apply"
MAX_DETAIL = 25

# Job entries are the only list-group-items on the page; splitting on the opening tag is steadier
# than matching a balanced <li>, because the entry itself contains nested <li>s for the location.
_ITEM_SPLIT = re.compile(r'<li class="list-group-item">')
_LINK_RE = re.compile(r'<a\s+href="(?P<url>https://[^"]*?/apply/[^"]+)"\s*>(?P<title>.*?)</a>', re.S)
_LOC_RE = re.compile(r"fa-map-marker'></i>(?P<loc>.*?)</li>", re.S)
_JSON_LD_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)
_DESC_OPEN_RE = re.compile(r'<div[^>]*\bid=["\']job-description["\'][^>]*>', re.I)
_DIV_RE = re.compile(r"<(/?)div\b[^>]*>", re.I)


def _text(s: str) -> str:
    """'AlphaLab &amp; Portfolio  Operations' -> 'AlphaLab & Portfolio Operations'."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def parse_jazzhr_detail(page: str) -> tuple[str, str | None]:
    """Read JazzHR's public JobPosting block without mixing in the application form.

    2026-10-27: every sampled JazzHR job page carries the full advert and posting date in
    JSON-LD. The board page has neither, which left all 194 current JazzHR roles without a
    description even though the employer exposes one on the student's destination page.
    Revert: remove this parser and the bounded detail pass below to restore board-only reads.
    """
    def postings(value):
        if isinstance(value, dict):
            kinds = value.get("@type")
            if kinds == "JobPosting" or isinstance(kinds, list) and "JobPosting" in kinds:
                yield value
            for child in value.values():
                yield from postings(child)
        elif isinstance(value, list):
            for child in value:
                yield from postings(child)

    for raw in _JSON_LD_RE.findall(page or ""):
        try:
            payload = json.loads(html.unescape(raw))
        except (TypeError, ValueError):
            continue
        job = next(postings(payload), None)
        if not job:
            continue
        posted = str(job.get("datePosted") or "")[:10] or None
        return html_to_text(job.get("description")), posted
    # Older JazzHR themes publish only Organization JSON-LD, but keep the same explicit visible
    # advert container. Balance divs so an embedded layout block cannot cut the description short.
    opened = _DESC_OPEN_RE.search(page or "")
    if opened:
        depth, body = 1, page[opened.end():]
        for tag in _DIV_RE.finditer(body):
            depth += -1 if tag.group(1) else 1
            if depth == 0:
                body = body[:tag.start()]
                break
        return html_to_text(body), None
    return "", None


def parse_jazzhr(page: str, co: dict) -> list[dict]:
    out, seen, board, counts = [], set(), [], counts_of(co)
    chunks = _ITEM_SPLIT.split(page or "")[1:]
    counts.rows(len(chunks))   # the job entries on the one board page; there is no total to compare
    for chunk in chunks:
        link = _LINK_RE.search(chunk)
        if not link:
            counts.discard("unreadable")
            continue
        loc = _LOC_RE.search(chunk)
        board.append(_text(loc.group("loc")) if loc else None)
        title = _text(link.group("title"))
        if not title:
            counts.discard("unreadable")
            continue
        if not is_internship(title):
            counts.discard("not_student")
            continue
        url = html.unescape(link.group("url"))
        if url in seen:
            counts.discard("duplicate")
            continue
        seen.add(url)
        out.append(board_item(co, source="jazzhr", title=title,
                              locations=[_text(loc.group("loc"))] if loc else [], url=url))
    place_bare_cities(out, board_state(board))
    return out


def fetch_jazzhr_board(c, co: dict) -> list[dict]:
    require_robots(c, f"https://{co['ats_token']}.applytojob.com", "/apply",
                   co["ats_token"])
    r = c.get(URL.format(tenant=co["ats_token"]))
    r.raise_for_status()
    items = parse_jazzhr(r.text, co)
    # The current corpus has no JazzHR board above 23 internships. Keep a ceiling anyway so a
    # newly discovered giant tenant cannot turn one board into an unbounded crawl.
    wanted = [i for i in items if not i["locations"] or any(maybe_in_region(l) for l in i["locations"])]
    for it in wanted[:MAX_DETAIL]:
        try:
            d = c.get(it["url"])
            if d.status_code == 200:
                desc, posted = parse_jazzhr_detail(d.text)
                it["description"] = desc
                it["posted_at"] = posted or it["posted_at"]
        except Exception:
            pass
    return items
