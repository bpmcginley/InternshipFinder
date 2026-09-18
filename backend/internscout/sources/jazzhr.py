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
import re

from .common import board_item
from ..classify import is_internship
from ..region import board_state, place_bare_cities

URL = "https://{tenant}.applytojob.com/apply"

# Job entries are the only list-group-items on the page; splitting on the opening tag is steadier
# than matching a balanced <li>, because the entry itself contains nested <li>s for the location.
_ITEM_SPLIT = re.compile(r'<li class="list-group-item">')
_LINK_RE = re.compile(r'<a\s+href="(?P<url>https://[^"]*?/apply/[^"]+)"\s*>(?P<title>.*?)</a>', re.S)
_LOC_RE = re.compile(r"fa-map-marker'></i>(?P<loc>.*?)</li>", re.S)


def _text(s: str) -> str:
    """'AlphaLab &amp; Portfolio  Operations' -> 'AlphaLab & Portfolio Operations'."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def parse_jazzhr(page: str, co: dict) -> list[dict]:
    out, seen, board = [], set(), []
    for chunk in _ITEM_SPLIT.split(page or "")[1:]:
        link = _LINK_RE.search(chunk)
        if not link:
            continue
        loc = _LOC_RE.search(chunk)
        board.append(_text(loc.group("loc")) if loc else None)
        title = _text(link.group("title"))
        if not title or not is_internship(title):
            continue
        url = html.unescape(link.group("url"))
        if url in seen:
            continue
        seen.add(url)
        out.append(board_item(co, source="jazzhr", title=title,
                              locations=[_text(loc.group("loc"))] if loc else [], url=url))
    place_bare_cities(out, board_state(board))
    return out


def fetch_jazzhr_board(c, co: dict) -> list[dict]:
    r = c.get(URL.format(tenant=co["ats_token"]))
    r.raise_for_status()
    return parse_jazzhr(r.text, co)
