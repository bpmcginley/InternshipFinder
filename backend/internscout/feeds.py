"""An RSS feed beside every landing page, so new listings reach the places students already are.

A club officer points a Discord bot (MonitoRSS), a Slack channel (/feed subscribe) or any feed reader
at, say, https://internscout.org/internships/software-engineering/massachusetts/feed.xml, and each
new role on that page is posted there as it is found. Nobody at InternScout posts anything: the
channel's own members chose to follow it, which is the only kind of promotion in a club space that
lasts.

Each item links straight to the employer's posting (a bot that sends people through an extra page
gets removed), and says where the rest of that page's listings are.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from email.utils import format_datetime
from html import escape

from .site import assets
from .site import feeds as _site_rss
from .site import source
from .site.text import safe_url

ITEMS = 25  # newest roles per feed; readers and bots only look at what is new since last time

# XML 1.0 forbids most control characters, which job boards do sometimes put in a title; HTML
# shrugs them off but one of them makes a whole feed unreadable.
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def _legacy_settings():
    # Preserve direct overrides on the compatibility facade when a caller already loaded it.
    return sys.modules.get(f"{__package__}.seo_pages")


def _x(text) -> str:
    return escape(_BAD_XML.sub("", str(text)))


def _rfc822(stamp, fallback: datetime) -> str:
    return format_datetime(source._when(stamp) or fallback)


def rss(
    path: str,
    h1: str,
    items: list[dict],
    now: datetime,
    state: str | None = None,
    limit: int | None = ITEMS,
) -> str:
    return _site_rss.rss(
        path,
        h1,
        items,
        now,
        state,
        limit,
        site=getattr(_legacy_settings(), "SITE", assets.SITE),
        place=source.place,
        pay_text=source.pay_text,
        safe_url=safe_url,
        xml_text=_x,
        rfc822=_rfc822,
    )


def write_all(site_dir: str, pages: list[dict], now: datetime | None = None) -> int:
    """feed.xml beside every landing page that lists roles (the hubs have none).

    Prefer the supplied snapshot date, then the last legacy build's date. A standalone call
    with neither uses the current UTC time."""
    now = now or getattr(_legacy_settings(), "GENERATED", None) or datetime.now(timezone.utc)
    return _site_rss.write_all(site_dir, pages, now, rss, ITEMS)
