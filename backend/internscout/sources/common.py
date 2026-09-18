"""Helpers shared by the ATS fetchers."""
from __future__ import annotations
import html
import re

from ..geo import REMOTE_RE, _NON_US, state_of

DESC_CHARS = 4000


def html_to_text(s: str | None) -> str:
    if not s:
        return ""
    s = html.unescape(s)  # Greenhouse double-escapes its HTML
    s = re.sub(r"<(br|/p|/li|/h\d|/div)\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def board_item(co: dict, *, source: str, title: str, locations: list, url: str | None,
               apply_url: str | None = None, posted_at=None, description: str = "",
               employment_type: str = "") -> dict:
    return {
        "company_name": co["name"],
        "title": title or "",
        "locations": seed_location(co, [l for l in locations if l]),
        "season": None, "year": None,
        "url": url,
        "apply_url": apply_url or url,
        "posted_at": posted_at,
        "description": (description or "")[:DESC_CHARS],
        "employment_type": employment_type or "",
        "active": True,
        "source": source,
        "source_url": url,
        "sector": co.get("sector"),
    }


def seed_location(co: dict, locations: list) -> list:
    """Add the employer's own place to a posting that named no state.

    A campus writes its locations the way it says them out loud - "Amherst Campus", "RIT Main
    Location", "L - 2 West 13th Street" - and every one of those reads as no US location at all,
    so the posting is dropped before it is ever tagged or shown. Where a seed entry says the one
    place its employer is, that place is appended, and the campus string stays in front of it so
    the card still shows the building a student would walk to.

    It is only ever consulted when nothing in the posting named a state, named somewhere abroad
    (Parsons has a Paris campus) or said remote, so neither a second office nor a work-from-home
    posting can be dragged home by it. And only a seed can set it - a prober's guess about where a
    company sits is not the same kind of fact.
    """
    where = co.get("location")
    if not where or any(state_of(l) or _NON_US.search(l) or REMOTE_RE.search(l) for l in locations):
        return locations
    return locations + [where]
