"""Render and write RSS beside the published listing pages."""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import format_datetime


def rss(
    path: str,
    h1: str,
    items: list[dict],
    now: datetime,
    state: str | None,
    limit: int | None,
    *,
    site: str,
    place: Callable[[dict, str | None], str],
    pay_text: Callable[[dict], str],
    safe_url: Callable[[str], str | None],
    xml_text: Callable[[object], str],
    rfc822: Callable[[object, datetime], str],
) -> str:
    url = site + path
    rows = []
    # Newest to InternScout, not newest posting: a reader or bot only wants what it has not seen yet.
    # Roles found in the same second stay in id order, so the same data makes the same feed.
    found = sorted(
        sorted(items, key=lambda x: str(x.get("id"))),
        key=lambda x: x.get("first_seen") or "",
        reverse=True,
    )
    # was: found = sorted(items, key=lambda x: x.get("first_seen") or "", reverse=True)
    for x in found[:limit]:
        bits = [place(x, state)]
        if x.get("term"):
            bits.append(str(x["term"]))
        pay = pay_text(
            x
        )  # was: str(x["salary"]) if x.get("salary") else ("Paid" if sp.is_paid(x) else "")
        if pay:
            bits.append(pay)
        rows.append(
            "<item>"
            f"<title>{xml_text((x.get('company_name') or '') + ': ' + (x.get('title') or ''))}</title>"
            f"<link>{xml_text(safe_url(x['apply_url']))}</link>"
            f"<guid isPermaLink=\"false\">internscout-{xml_text(x['id'])}</guid>"
            f"<pubDate>{rfc822(x.get('first_seen'), now)}</pubDate>"
            f"<description>{xml_text(' · '.join(bits) + '. More like this: ' + url)}</description>"
            "</item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
        f"<title>{xml_text(h1)} | InternScout</title>\n"
        f"<link>{xml_text(url)}</link>\n"
        f'<atom:link href="{xml_text(url)}feed.xml" rel="self" type="application/rss+xml"/>\n'
        f"<description>{xml_text(h1)}: new listings as InternScout finds them. Check each posting on the "
        "employer's site before applying.</description>\n"
        "<language>en-us</language>\n"
        f"<lastBuildDate>{format_datetime(now.astimezone(timezone.utc))}</lastBuildDate>\n"
        "<ttl>180</ttl>\n" + "\n".join(rows) + "\n</channel>\n</rss>\n"
    )


def write_all(
    site_dir: str,
    pages: list[dict],
    now: datetime,
    render: Callable[[str, str, list[dict], datetime, str | None, int | None], str],
    limit: int,
) -> int:
    n = 0
    for p in pages:
        if p.get("items") is None:
            continue
        folder = os.path.join(site_dir, p["path"].strip("/").replace("/", os.sep))
        with open(os.path.join(folder, "feed.xml"), "w", encoding="utf-8", newline="\n") as f:
            f.write(
                render(
                    p["path"], p["h1"], p["items"], now, p.get("state"), p.get("feed_limit", limit)
                )
            )
        n += 1
    return n
