"""The crawlable landing pages: made only where there is enough to show, safe against whatever a job
board puts in a title, and pointing only at real web links."""
import json
import os
import re

from internscout import seo_pages


def _row(i, state="MA", tags=("mechanical",), **over):
    row = {
        "id": f"id{i}", "company_name": f"Company {i}", "title": f"Mechanical Intern {i}",
        "field_tags": list(tags), "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "posted_at": "2026-09-20T00:00:00", "first_seen": f"2026-09-2{i % 3}T00:00:00",
        "regions": [{"loc": f"Town {i}, {state}", "kind": "x", "state": state}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, files, majors=None):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    index = {"generated_at": "2026-09-23T10:00:00+00:00", "files": {}}
    for key, rows in files.items():
        (data / f"{key}.json").write_text(json.dumps(rows), encoding="utf-8")
        index["files"][key] = {"file": f"listings/{key}.json"}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": majors or []}), encoding="utf-8")
    return str(tmp_path)


def _paths(pages):
    return {p["path"] for p in pages}


def test_pages_only_where_there_are_enough_open_listings(tmp_path):
    ma = [_row(i) for i in range(15)]                                 # 15 mechanical in MA
    ny = [_row(20 + i, state="NY") for i in range(6)]                 # 6 in NY
    ct = [_row(40 + i, state="CT") for i in range(3)]                 # only 3 in CT
    site = _site(tmp_path, {"MA": ma, "NY": ny, "CT": ct})
    paths = _paths(seo_pages.build(site))
    assert "/internships/mechanical-engineering/" in paths
    assert "/internships/massachusetts/" in paths
    assert "/internships/mechanical-engineering/massachusetts/" in paths
    assert "/internships/new-york/" in paths                         # a state needs MIN_OPEN
    assert "/internships/mechanical-engineering/new-york/" not in paths   # a field in a state, MIN_COMBO
    assert "/internships/connecticut/" not in paths                  # 3 < MIN_OPEN
    assert "/internships/mechanical-engineering/connecticut/" not in paths
    assert "/internships/" in paths


def test_closed_and_non_web_links_are_left_out(tmp_path):
    rows = [_row(i) for i in range(4)]
    rows.append(_row(4, status="closed"))
    rows.append(_row(5, apply_url="javascript:alert(1)"))
    site = _site(tmp_path, {"MA": rows})
    # Only 4 usable listings, so nothing but the hubs is built.
    assert _paths(seo_pages.build(site)) == {"/internships/", "/internships/for/", "/internships/at/"}


def test_job_board_text_is_escaped(tmp_path):
    rows = [_row(i) for i in range(5)]
    rows[0]["title"] = '<script>alert("x")</script>Intern'
    rows[1]["company_name"] = 'Evil & Co "</title>'
    site = _site(tmp_path, {"MA": rows})
    for p in seo_pages.build(site):
        assert "<script>alert" not in p["html"]
        assert '"</title>' not in p["html"]
    page = next(p for p in seo_pages.build(site) if p["path"] == "/internships/massachusetts/")
    assert "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;Intern" in page["html"]


def test_state_page_shows_the_location_in_that_state(tmp_path):
    rows = [_row(i) for i in range(5)]
    rows[0]["regions"] = [{"loc": "New York, NY", "kind": "x", "state": "NY"},
                          {"loc": "Boston, MA", "kind": "x", "state": "MA"}]
    site = _site(tmp_path, {"MA": rows, "NY": [rows[0]]})
    page = next(p for p in seo_pages.build(site) if p["path"] == "/internships/massachusetts/")
    assert "Boston, MA +1" in page["html"]
    assert "New York, NY +1" not in page["html"]


def test_major_pages_put_the_northeast_first(tmp_path):
    far = [_row(i, state="TX", tags=("sports",)) for i in range(5)] + [_row(5, state="TX", tags=("hospitality",))]
    near = [_row(20, state="MA", tags=("sports",), first_seen="2026-01-01T00:00:00")]
    site = _site(tmp_path, {"TX": far, "MA": near},
                 majors=[{"name": "Sport Management", "tags": ["sports", "hospitality"], "related": [], "level": "undergrad"}])
    page = next(p for p in seo_pages.build(site) if p["path"] == "/internships/for/sport-management-majors/")
    # The Massachusetts role is the oldest, and still listed before every Texas one. (Only the list
    # itself is compared: the opening paragraph names top employers in its own order.)
    jobs = page["html"][page["html"].index('<ul class="jobs">'):]
    order = re.findall(r'"co">Company (\d+)', jobs)
    assert order[0] == "20" and sorted(order[1:]) == ["0", "1", "2", "3", "4", "5"]


def test_sitemap_and_robots(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    seo_pages.write(site, seo_pages.build(site))
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "<loc>https://internscout.org/internships/massachusetts/</loc>" in sitemap
    assert "<loc>https://internscout.org/privacy</loc>" in sitemap
    robots = open(os.path.join(site, "robots.txt"), encoding="utf-8").read()
    assert "Sitemap: https://internscout.org/sitemap.xml" in robots
    assert "Disallow: /data/" in robots
    assert os.path.exists(os.path.join(site, "internships", "massachusetts", "index.html"))


def test_analytics_snippet_comes_from_the_dashboard(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    snippet = "<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{}'></script>"
    (tmp_path / "index.html").write_text(f"<html><body>{snippet}</body></html>", encoding="utf-8")
    assert all(snippet in p["html"] for p in seo_pages.build(site))
    (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
    assert all("cloudflareinsights" not in p["html"] for p in seo_pages.build(site))


def test_field_and_state_slugs_never_collide():
    states = {seo_pages.state_slug(k) for k in seo_pages.US_STATES}
    assert not states & {seo_pages.field_slug(t) for t in seo_pages.FIELD_TITLES}
    assert "for" not in states


def test_dashboard_links_open_on_the_page_topic(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(15)] + [_row(15, tags=("aerospace",))]},
                 majors=[{"name": "Mechanical Engineering", "tags": ["mechanical", "aerospace", "other"], "level": "undergrad"}])
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    assert 'href="/?field=mechanical"' in pages["/internships/mechanical-engineering/"]
    assert 'href="/?state=MA"' in pages["/internships/massachusetts/"]
    assert 'href="/?field=mechanical&amp;state=MA"' in pages["/internships/mechanical-engineering/massachusetts/"]
    assert 'href="/?field=mechanical,aerospace"' in pages["/internships/for/mechanical-engineering-majors/"]
    # docs/js/app.js takes only values shaped like these; anything else would open an empty list.
    assert all(re.fullmatch(r"[a-z_]{2,32}", t) for t in seo_pages.FIELD_TITLES)
    assert all(re.fullmatch(r"[A-Z]{2}|remote", k) for k in seo_pages.US_STATES)


def test_a_major_with_the_same_listings_as_another_page_is_folded_into_it(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]},
                 majors=[{"name": "Mechanical Engineering", "tags": ["mechanical"], "level": "undergrad"},
                         {"name": "Engineering Mechanics", "tags": ["mechanical", "other"], "level": "undergrad"}])
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    assert not any(p.startswith("/internships/for/") and p.endswith("-majors/") for p in pages)
    assert "The page for Engineering Mechanics and Mechanical Engineering majors." in pages["/internships/mechanical-engineering/"]
    hub = pages["/internships/for/"]
    assert hub.count('href="/internships/mechanical-engineering/"') == 2


def test_every_combo_page_is_linked_from_its_field_and_state(tmp_path):
    rows = [_row(i, tags=(f"f{i % 14}", "mechanical")) for i in range(14 * seo_pages.MIN_COMBO)]
    site = _site(tmp_path, {"MA": rows})
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    combos = [p for p in pages if p.count("/") == 4 and "/for/" not in p]
    assert len(combos) > seo_pages.RELATED
    for p in combos:
        field, state = p.split("/")[2:4]
        assert f'href="{p}"' in pages[f"/internships/{field}/"]
        assert f'href="{p}"' in pages[f"/internships/{state}/"]


def test_a_live_page_stays_until_it_falls_well_below_the_bar(tmp_path):
    page = "/internships/massachusetts/"
    four = _site(tmp_path / "four", {"MA": [_row(i) for i in range(4)]})
    assert page not in _paths(seo_pages.build(four))                   # new pages need MIN_OPEN
    assert page in _paths(seo_pages.build(four, {page}))                # a live one keeps going
    two = _site(tmp_path / "two", {"MA": [_row(i) for i in range(2)]})
    assert page not in _paths(seo_pages.build(two, {page}))             # until it drops below keep_at


def test_live_paths_reads_the_previous_sitemap(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    seo_pages.write(site, seo_pages.build(site))
    live = seo_pages.live_paths(os.path.join(site, "sitemap.xml"))
    assert {"/", "/internships/", "/internships/massachusetts/"} <= live
    assert seo_pages.live_paths(os.path.join(site, "missing.xml")) == set()


def test_lastmod_follows_the_listings_and_hubs_carry_no_one_item_breadcrumb(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    pages = seo_pages.build(site)
    seo_pages.write(site, pages)
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    # The newest listing on the page was first seen 2026-09-22, whatever day the build runs.
    assert "<loc>https://internscout.org/internships/massachusetts/</loc><lastmod>2026-09-22</lastmod>" in sitemap
    assert "<loc>https://internscout.org/install.html</loc></url>" in sitemap
    html = {p["path"]: p["html"] for p in pages}
    assert "application/ld+json" not in html["/internships/"]
    assert "application/ld+json" in html["/internships/massachusetts/"]


def test_page_text_keeps_acronyms_and_skips_yearless_terms(tmp_path):
    rows = [_row(i, tags=("ml",), term="Summer 2027" if i < 4 else "Summer") for i in range(7)]
    site = _site(tmp_path, {"MA": rows})
    html = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/machine-learning-ai/")
    assert "open student roles in machine learning and AI," in html
    assert "The most common start term is Summer 2027." in html


def test_newest_means_newest_posting_not_newest_scan():
    old_post = _row(1, posted_at="2024-09-23T00:00:00", first_seen="2026-09-22T00:00:00")
    fresh = _row(2, posted_at="2026-09-21T00:00:00", first_seen="2026-09-21T00:00:00")
    undated = _row(3, posted_at=None, first_seen="2026-09-23T00:00:00")
    assert [x["id"] for x in seo_pages.newest_first([old_post, undated, fresh])] == ["id2", "id1", "id3"]


def test_postings_filed_everywhere_do_not_make_combo_pages(tmp_path):
    rows = [_row(i) for i in range(seo_pages.MIN_COMBO)]
    states = ["MA", "NY", "CT", "RI", "NH", "VT", "ME", "NJ", "PA", "OH", "TX", "CA"]    # 12 states each
    site = _site(tmp_path, {k: rows for k in states})
    paths = _paths(seo_pages.build(site))
    assert "/internships/massachusetts/" in paths
    assert "/internships/mechanical-engineering/massachusetts/" not in paths


def test_missing_pages_get_a_way_back(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    seo_pages.write(site, seo_pages.build(site))
    html = open(os.path.join(site, "404.html"), encoding="utf-8").read()
    assert '<meta name="robots" content="noindex"/>' in html and "canonical" not in html
    assert 'href="/internships/"' in html


def test_employers_with_enough_roles_get_a_page_and_their_name_links_to_it(tmp_path):
    big = [_row(i, company_name="Big Co") for i in range(seo_pages.MIN_EMPLOYER)]
    small = [_row(50 + i, company_name="Small Co") for i in range(seo_pages.MIN_EMPLOYER - 1)]
    site = _site(tmp_path, {"MA": big + small})
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    assert "/internships/at/big-co/" in pages and "/internships/at/small-co/" not in pages
    own = pages["/internships/at/big-co/"]
    assert "InternScout is not affiliated with Big Co." in own
    assert 'href="/?q=Big%20Co"' in own
    assert '<a href="/internships/at/big-co/">Big Co</a>' not in own          # no link to itself
    ma = pages["/internships/massachusetts/"]
    assert '<a href="/internships/at/big-co/">Big Co</a>' in ma
    assert '"co">Small Co' in ma                                              # no page, so no link
    assert 'href="/internships/at/big-co/"' in pages["/internships/at/"]


def test_new_this_week_has_only_fresh_roles(tmp_path):
    rows = [_row(i) for i in range(6)]                                        # found Sep 20-22
    rows.append(_row(7, company_name="Old Post", posted_at="2024-01-01T00:00:00"))
    rows.append(_row(8, company_name="Long Ago", first_seen="2026-08-01T00:00:00"))
    site = _site(tmp_path, {"MA": rows})
    page = next(p for p in seo_pages.build(site) if p["path"] == "/internships/new/")
    assert {x["id"] for x in page["items"]} == {f"id{i}" for i in range(6)}
    assert "Old Post" not in page["html"] and "Long Ago" not in page["html"]


def test_the_day_first_seen_began_is_not_this_weeks_news(tmp_path):
    # Most listings carry the day first_seen started being kept; only later finds are new.
    start = [_row(i, first_seen="2026-09-18T00:00:00") for i in range(10)]
    later = [_row(20 + i, first_seen="2026-09-22T00:00:00") for i in range(5)]
    site = _site(tmp_path, {"MA": start + later})
    pages = {p["path"]: p for p in seo_pages.build(site)}
    assert {x["id"] for x in pages["/internships/new/"]["items"]} == {f"id{20 + i}" for i in range(5)}
    assert pages["/internships/massachusetts/"]["html"].count('class="new"') == 5
