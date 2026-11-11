"""Shared HTML layout, accessible tables, and page shell rendering."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from html import escape as esc

from ..text import join_words


@dataclass(frozen=True)
class Shell:
    site: str
    org_id: str
    organization: dict
    css: str
    slogan: str
    beacon: str
    digest_form: str
    offer_tag: str
    offer_mark: str


def ld_script(obj) -> str:
    """One JSON-LD block, safe to put in a page whatever its strings hold.

    "</" inside a script block would end it early, and so can "<!--" followed by "<script": an
    employer named "<!--<script>" puts the parser in a state where the real </script> no longer
    closes the block, and the page after it becomes script. So no "<", ">" or "&" appears in the
    block at all: JSON reads <, > and & as the same characters, and they only ever
    occur inside strings (they are not JSON punctuation), so replacing them is always safe."""
    ld_json = (
        json.dumps(obj, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )
    # was: ld_json = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">{ld_json}</script>'


def faq_ld(qa: list[tuple[str, str]]) -> dict:
    """The FAQPage block for (question, answer) pairs; the answers are plain text, as on the page."""
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
            for q, a in qa
        ],
    }


def faq_section(qa: list[tuple[str, str]]) -> str:
    return (
        (
            "<section class=\"faq\">"
            + "".join(f"<h2>{esc(q)}</h2><p>{esc(a)}</p>" for q, a in qa)
            + "</section>"
        )
        if qa
        else ""
    )


def link_list(title: str, links: list[tuple[str, str, int]]) -> str:
    if not links:
        return ""
    lis = "".join(
        f"<li><a href=\"{esc(href)}\">{esc(label)}</a> <span class=\"n\">{n:,}</span></li>"
        for href, label, n in links
    )
    return f"<section class=\"rel\"><h2>{esc(title)}</h2><ul>{lis}</ul></section>"


def fits_line(majors: list[str]) -> str:
    return (
        (
            f"<p class=\"fits\">The page for {esc(join_words(sorted(majors)))} "
            f"{'majors' if len(majors) > 1 else 'majors too'}.</p>"
        )
        if majors
        else ""
    )


def tablewrap(label: str) -> str:
    """The opening of the box a wide table scrolls sideways in. A keyboard can reach and scroll it, and a
    screen reader names it (2026-10-14, D24; was: a bare <div class="tablewrap">)."""
    return f"<div class=\"tablewrap\" tabindex=\"0\" role=\"region\" aria-label=\"{esc(label)}\">"


def table(
    head: list[str],
    rows: list[list[str]],
    num_from: int = 1,
    cls: str = "data",
    label: str = "Table",
) -> str:
    """An HTML table; cells are HTML already. Columns from num_from on hold figures and don't wrap.
    label: what the table is, for the scrolling box's name (tablewrap)."""
    # Explicit roles retain table relationships when narrow-screen CSS stacks the rows.
    # Repeated visible labels are decorative; the real column headers stay in the accessibility tree.
    th = "".join(f'<th scope="col" role="columnheader">{h}</th>' for h in head)
    body = "".join(
        '<tr role="row">'
        + "".join(
            f'<th scope="row" role="rowheader">{c}</th>'
            if i == 0 and i < num_from
            else f'<td class="{"num" if i >= num_from else ""}" role="cell">'
            f'<span class="cell-label" aria-hidden="true">{head[i] if i < len(head) else ""}</span>'
            f'<span class="cell-value">{c}</span></td>'
            for i, c in enumerate(r)
        )
        + "</tr>"
        for r in rows
    )
    return (
        f'{tablewrap(label)}<table class="{cls}" role="table">'
        f'<thead role="rowgroup"><tr role="row">{th}</tr></thead>'
        f'<tbody role="rowgroup">{body}</tbody></table></div>'
    )


def short_day(day) -> str:
    return f"{day:%b} {day.day}, {day.year}"


def page(
    path: str,
    title: str,
    description: str,
    h1: str,
    crumbs: list[tuple[str, str]],
    body: str,
    updated: str,
    index: bool,
    feed: bool,
    ld: tuple | list,
    thin: bool,
    *,
    shell: Shell,
    footer_browse: Callable[[], str],
    ld_script: Callable[[dict], str],
    esc: Callable[[str], str],
) -> str:
    robots = (
        f'<link rel="canonical" href="{esc(shell.site + path)}"/>\n<meta name="robots" content="noindex, follow"/>'
        if thin
        else f'<link rel="canonical" href="{esc(shell.site + path)}"/>'
        if index
        else '<meta name="robots" content="noindex"/>'
    )
    # was, in the head: the canonical link if index, else the noindex meta (no thin pages)
    url = shell.site + path
    # One crumb is not a trail: no line at all, rather than a lone "› Internships" (2026-10-14, D24).
    # was: the line on every page, " › Internships" on the hub.
    crumb_html = (
        (
            "<p class=\"crumbs\">"
            + " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1])
            + f" › {esc(crumbs[-1][1])}</p>\n"
        )
        if len(crumbs) > 1
        else ""
    )
    trail = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": t, "item": shell.site + h}
            for i, (h, t) in enumerate(crumbs)
        ],
    }
    # A breadcrumb trail of one is not a trail (Google reports it as invalid), so the hub has none.
    # (The escaping that was here is ld_script's, since 2026-10-02.)
    # Every page carries the Organization since 2026-10-05 (the audit: 2 of 297 did), once: a page
    # that passes it in `ld` (the hub, /about/, /pricing/) is not given a second copy.
    # was: ld_tag = "\n".join(([ld_script(trail)] if len(crumbs) > 1 else []) + [ld_script(o) for o in ld])
    objs = list(ld) + (
        [] if any(o.get("@id") == shell.org_id for o in ld) else [shell.organization]
    )
    ld_tag = "\n".join(
        ([ld_script(trail)] if len(crumbs) > 1 else []) + [ld_script(o) for o in objs]
    )
    # was: ld_tag = f'<script type="application/ld+json">{ld_json}</script>' if len(crumbs) > 1 else ""
    # The footer links /about/ and /compare/ from every page (2026-10-02), so crawlers and answer
    # engines reach the pages that say what InternScout is. was: only Privacy and Terms.
    # The header names what the install page offers and that it costs nothing (2026-10-04).
    # was: <a href="/install.html">Extension</a>
    # Pricing, Compare and About are in the nav since 2026-10-05 (the audit: the comparison page, the
    # site's best price story, was reachable only from the footer, and the prices had no page at all).
    # was: <nav><a href="/">Dashboard</a><a href="/internships/">Browse</a><a href="/install.html">Auto-Apply (free)</a></nav>
    # A landing visitor can find the optional digest before scrolling through the listings.
    # Reuse the existing nav link counter; the lower form keeps its landing placement.
    digest_nav = (
        '<a class="nav-extra" href="/digest/" data-digest-placement="nav">Free Monday email</a>'
        if shell.digest_form and path.startswith("/internships/")
        else ""
    )
    digest_footer = (
        '<span class="mobile-digest"> · <a href="/digest/" '
        'data-digest-placement="footer">Free Monday email</a></span>'
        if digest_nav
        else ""
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}"/>
{robots}
<meta property="og:title" content="{esc(title)}"/>
<meta property="og:description" content="{esc(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{esc(url)}"/>
<meta property="og:image" content="{shell.site}/og-preview.png"/>
<meta name="twitter:card" content="summary_large_image"/>
{f'<link rel="alternate" type="application/rss+xml" title="{esc(h1)} | InternScout" href="feed.xml"/>' if feed else ""}
<link rel="icon" type="image/png" sizes="48x48" href="/icon48.png"/>
<link rel="apple-touch-icon" href="/icon128.png"/>
<link rel="preload" href="/fonts/ibm-plex-sans-latin.woff2" as="font" type="font/woff2" crossorigin/>
<link rel="preload" href="/fonts/source-serif-4-latin.woff2" as="font" type="font/woff2" crossorigin/>
<style>{shell.css}</style>
{ld_tag}
</head>
<body>
<div class="wrap">
<header><a class="mark" href="/">InternScout</a><nav aria-label="Primary"><a href="/">Dashboard</a><a href="/internships/">Browse</a>{digest_nav}<a href="/install.html">Auto-Apply (free)</a><a class="nav-extra" href="/pricing/">Pricing</a><a class="nav-extra" href="/compare/">Compare</a><a class="nav-extra" href="/about/">About</a><a class="nav-extra" href="/employers/" data-employer-entry="nav">Hire interns</a></nav></header>
<main>
{crumb_html}<h1>{esc(h1)}</h1>
{body}
<p class="updated">Updated {esc(updated)}. Listings are collected from public job boards several times a day; always check the posting on the employer's site before applying.</p>
</main>
<footer><nav class="distribution-links" aria-label="More ways to use InternScout">
<a href="https://github.com/bpmcginley/internships-every-major" data-distribution="list">Internships for every major on GitHub</a>
<a href="/widget/builder.html" data-distribution="widget">Put live internships on your club or department site</a>
</nav><strong>{shell.slogan}</strong> InternScout is a free internship search made by a UMass Amherst student. Not affiliated with UMass Amherst. {footer_browse()}<a href="/about/">About</a> · <a href="/pricing/">Pricing</a> · <a href="/compare/">Compare</a> · <a href="/employers/" data-employer-entry="footer">For employers</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>{digest_footer}</footer>
</div>
{shell.beacon}
{shell.offer_tag if shell.offer_mark in body else ""}
</body>
</html>
"""
