"""Read the live sitemap and write the crawler discovery files."""

from __future__ import annotations

import os
import re
from collections.abc import Callable


from .assets import SITE

SITE_PATH = re.compile("^" + re.escape(SITE))


def write_sitemap(
    site_dir: str,
    pages: list[dict],
    home_lastmod: str | None,
    site: str,
    escape: Callable[[str], str],
) -> None:
    # The dashboard gets its own content date below (2026-10-23); was: the browse hub's date. Other
    # static pages still carry no lastmod rather than a made-up one. Revert: remove the '/' override.
    hub = next((p["lastmod"] for p in pages if p["path"] == "/internships/"), None)
    # /employers/ (2026-10-13) is hand-written in docs/employers/index.html, like install.html.
    # was: urls = [("/", hub), ("/install.html", None), ("/privacy", None), ("/terms", None)] + \
    urls = [
        ("/", hub),
        ("/install.html", None),
        ("/employers/", None),
        ("/privacy", None),
        ("/terms", None),
    ] + [(p["path"], p.get("lastmod")) for p in pages if p.get("index", True)]
    # A noindex page (index False: /digest/ before its form has an address) stays out of the sitemap.
    # was: [(p["path"], p.get("lastmod")) for p in pages]
    with open(os.path.join(site_dir, "sitemap.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        )
        for u, mod in urls:
            if u == "/":
                mod = home_lastmod
            f.write(
                f"  <url><loc>{escape(site + u)}</loc>"
                + (f"<lastmod>{mod}</lastmod>" if mod else "")
                + "</url>\n"
            )
        f.write("</urlset>\n")


def write_robots(site_dir: str, site: str) -> None:
    with open(os.path.join(site_dir, "robots.txt"), "w", encoding="utf-8", newline="\n") as f:
        # No "Disallow: /data/": the dashboard at / (canonical, and in the sitemap) fetches its listings
        # from ./data/ in the browser, and a crawler barred from them renders it as an empty shell. The
        # files there are JSON, which search engines do not list as pages anyway.
        # The comment (2026-10-02) only says out loud what "User-agent: *" already allows: AI search and
        # answer crawlers read the site like any other. A group of their own would change nothing, and
        # a crawler that matches a named group ignores the "*" one, so a later edit to one could
        # silently stop applying to them.
        # Google and Bing skip the per-page RSS feeds (2026-10-07). Search Console: 687 pages "discovered -
        # currently not indexed", and most of the 21 "crawled - currently not indexed" were feed.xml files,
        # one per page and each linked from its page's head, so the two engines spent their visits on
        # ~1,360 feeds instead of the pages. Feed readers and every other crawler keep the "*" group. The
        # named group replaces "*" for those two (the warning above), so it says Allow: / again.
        # was: f"User-agent: *\nAllow: /\n\nSitemap: {site}/sitemap.xml\n" after the comment.
        f.write(
            "# Every crawler is welcome, AI search and answer engines included: GPTBot, OAI-SearchBot,\n"
            "# ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, Bingbot and\n"
            f"# Applebot-Extended. A summary for language models: {site}/llms.txt\n"
            "User-agent: *\nAllow: /\n\n"
            "# Google and Bing: every page, but not the per-page RSS feeds, which are for feed readers.\n"
            "User-agent: Googlebot\nUser-agent: Bingbot\nAllow: /\nDisallow: /*feed.xml$\n\n"
            f"Sitemap: {site}/sitemap.xml\n"
        )
        # was: f.write(f"User-agent: *\nAllow: /\n\nSitemap: {site}/sitemap.xml\n")
        # was: f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
        #              f"Disallow: /data/\n\nSitemap: {site}/sitemap.xml\n")


def live_paths(sitemap: str, site_path: re.Pattern[str]) -> dict[str, str]:
    try:
        with open(sitemap, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return {}
    return {
        site_path.sub("", loc): mod
        for loc, mod in re.findall(r"<loc>([^<]+)</loc>(?:<lastmod>([^<]*)</lastmod>)?", text)
    }
