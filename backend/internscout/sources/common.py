"""Helpers shared by the ATS fetchers."""
from __future__ import annotations
import html
import re

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
        "locations": [l for l in locations if l],
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
