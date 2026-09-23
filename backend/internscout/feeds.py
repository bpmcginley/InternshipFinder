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

import os
import re
from datetime import datetime, timezone
from email.utils import format_datetime

from . import seo_pages as sp

ITEMS = 25          # newest roles per feed; readers and bots only look at what is new since last time

# XML 1.0 forbids most control characters, which job boards do sometimes put in a title; HTML
# shrugs them off but one of them makes a whole feed unreadable.
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def _x(text) -> str:
    return sp.esc(_BAD_XML.sub("", str(text)))


def _rfc822(stamp, fallback: datetime) -> str:
    return format_datetime(sp._when(stamp) or fallback)


def rss(path: str, h1: str, items: list[dict], now: datetime, state: str | None = None,
        limit: int | None = ITEMS) -> str:
    url = sp.SITE + path
    rows = []
    # Newest to InternScout, not newest posting: a reader or bot only wants what it has not seen yet.
    found = sorted(items, key=lambda x: x.get("first_seen") or "", reverse=True)
    for x in found[:limit]:
        bits = [sp.place(x, state)]
        if x.get("term"):
            bits.append(str(x["term"]))
        pay = str(x["salary"]) if x.get("salary") else ("Paid" if sp.is_paid(x) else "")
        if pay:
            bits.append(pay)
        rows.append(
            "<item>"
            f"<title>{_x((x.get('company_name') or '') + ': ' + (x.get('title') or ''))}</title>"
            f"<link>{_x(sp.safe_url(x['apply_url']))}</link>"
            f"<guid isPermaLink=\"false\">internscout-{_x(x['id'])}</guid>"
            f"<pubDate>{_rfc822(x.get('first_seen'), now)}</pubDate>"
            f"<description>{_x(' · '.join(bits) + '. More like this: ' + url)}</description>"
            "</item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
            f"<title>{_x(h1)} | InternScout</title>\n"
            f"<link>{_x(url)}</link>\n"
            f'<atom:link href="{_x(url)}feed.xml" rel="self" type="application/rss+xml"/>\n'
            f"<description>{_x(h1)}: new listings as InternScout finds them. Check each posting on the "
            "employer's site before applying.</description>\n"
            "<language>en-us</language>\n"
            f"<lastBuildDate>{format_datetime(now.astimezone(timezone.utc))}</lastBuildDate>\n"
            "<ttl>180</ttl>\n"
            + "\n".join(rows)
            + "\n</channel>\n</rss>\n")


def write_all(site_dir: str, pages: list[dict]) -> int:
    """feed.xml beside every landing page that lists roles (the hubs have none)."""
    now = datetime.now(timezone.utc)
    n = 0
    for p in pages:
        if p.get("items") is None:
            continue
        folder = os.path.join(site_dir, p["path"].strip("/").replace("/", os.sep))
        with open(os.path.join(folder, "feed.xml"), "w", encoding="utf-8", newline="\n") as f:
            f.write(rss(p["path"], p["h1"], p["items"], now, p.get("state"), p.get("feed_limit", ITEMS)))
        n += 1
    return n
