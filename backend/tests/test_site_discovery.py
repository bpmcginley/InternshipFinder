"""Generated sitemap, crawler rules, feed discovery and LLM artifacts."""

import os

from internscout import seo_pages
from test_seo_pages import _pay_site, _row, _site


def test_sitemap_and_robots(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    seo_pages.write(site, seo_pages.build(site))
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "<loc>https://internscout.org/internships/massachusetts/</loc>" in sitemap
    assert "<loc>https://internscout.org/privacy</loc>" in sitemap
    robots = open(os.path.join(site, "robots.txt"), encoding="utf-8").read()
    assert "Sitemap: https://internscout.org/sitemap.xml" in robots
    # The dashboard at / reads ./data/ in the browser; a crawler barred from it sees an empty shell.
    assert "/data" not in robots  # was: assert "Disallow" not in robots (the feeds, 2026-10-07)
    # AI search and answer crawlers are named only in a comment: "User-agent: *" already lets them in.
    assert (
        "User-agent: *\nAllow: /\n\n" in robots
        and "OAI-SearchBot" in robots
        and "ClaudeBot" in robots
    )
    # was: assert robots.count("User-agent:") == 1   (Google and Bing have a group since 2026-10-07)
    assert robots.count("User-agent:") == 3
    assert os.path.exists(os.path.join(site, "internships", "massachusetts", "index.html"))


def _robots_groups(text):
    """{user agent: [rules]} as RFC 9309 reads robots.txt: User-agent lines in a row share one group."""
    groups, agents, in_agents = {}, [], False
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (s.strip() for s in line.split(":", 1))
        if key.lower() == "user-agent":
            agents = agents + [value] if in_agents else [value]
            in_agents = True
            groups.setdefault(value, [])
        elif key.lower() in ("allow", "disallow"):
            in_agents = False
            for a in agents:
                groups[a].append(f"{key}: {value}")
    return groups


def test_google_and_bing_skip_the_feeds_and_everyone_else_is_unchanged(tmp_path):
    # 2026-10-07: the per-page feeds were taking Google's crawl visits from the pages themselves.
    from internscout import feeds

    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    pages = seo_pages.build(site)
    seo_pages.write(site, pages)
    feeds.write_all(site, pages, seo_pages.GENERATED)
    groups = _robots_groups(open(os.path.join(site, "robots.txt"), encoding="utf-8").read())
    assert groups["*"] == ["Allow: /"]
    for bot in ("Googlebot", "Bingbot"):
        assert groups[bot] == ["Allow: /", "Disallow: /*feed.xml$"]  # a named group restates Allow
    # The feeds are still written and still linked; only those two crawlers leave them alone.
    page = open(
        os.path.join(site, "internships", "massachusetts", "index.html"), encoding="utf-8"
    ).read()
    assert 'type="application/rss+xml"' in page and 'href="feed.xml"' in page
    assert os.path.exists(os.path.join(site, "internships", "massachusetts", "feed.xml"))


def test_live_paths_reads_the_previous_sitemap(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    seo_pages.write(site, seo_pages.build(site))
    live = seo_pages.live_paths(os.path.join(site, "sitemap.xml"))
    assert {"/", "/internships/", "/internships/massachusetts/"} <= set(live)
    assert live["/internships/massachusetts/"] == "2026-09-22" and live["/install.html"] == ""
    assert seo_pages.live_paths(os.path.join(site, "missing.xml")) == {}


def test_llms_txt_links_the_key_pages_with_numbers_from_the_data(tmp_path):
    site = _pay_site(tmp_path)
    seo_pages.write(site, seo_pages.build(site))
    short = open(os.path.join(site, "llms.txt"), encoding="utf-8").read()
    full = open(os.path.join(site, "llms-full.txt"), encoding="utf-8").read()
    # llmstxt.org: an H1 name, a blockquote summary, then sections of markdown links.
    assert short.startswith(
        "# InternScout\n\n> InternScout (https://internscout.org) is a free internship search"
    )
    # Counted from this data (41 open, 9 employers, 1 field) and dated from the export, not the clock.
    assert (
        "As of September 23, 2026 it lists 41 open internships, co-ops and research roles from 9 employers in 1 field"
        in short
    )
    for path in (
        "/",
        "/about/",
        "/pricing/",
        "/compare/",
        "/internships/highest-paying/",
        "/internships/",
        "/internships/at/",
        "/internships/for/",
        "/internships/mechanical-engineering/",
        "/install.html",
        "/privacy",
        "/terms",
        "/llms-full.txt",
    ):
        assert f"](https://internscout.org{path})" in short, path
    assert seo_pages.SLOGAN in short and "never submits" in short and "$4/month" in short
    assert "## Optional" in short
    assert full.startswith("# InternScout\n\n> ")
    assert (
        "- [Mechanical Engineering](https://internscout.org/internships/mechanical-engineering/): 41 open"
        in full
    )
    assert "the highest is $49 an hour" in full and "Not affiliated with UMass Amherst" in full
    assert "Data as of September 23, 2026." in full
    # Only employers with enough open roles have a page, so llms-full doesn't say every one does (review).
    assert "Every field, state, employer and major with enough open roles has a plain page" in full
    assert "and so are roles only in Canada (paid in Canadian dollars)" in full
    # Not a page: no sitemap entry, but robots.txt and /about/ point to it.
    assert "llms" not in open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert (
        "https://internscout.org/llms.txt"
        in open(os.path.join(site, "robots.txt"), encoding="utf-8").read()
    )
