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
    # Only 4 usable listings, so nothing but the hubs, and /about/ and /compare/ (2026-10-02), is built.
    assert _paths(seo_pages.build(site)) == {"/internships/", "/internships/for/", "/internships/at/", "/about/", "/compare/"}
    # was: == {"/internships/", "/internships/for/", "/internships/at/"}


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
    # The dashboard at / reads ./data/ in the browser; a crawler barred from it sees an empty shell.
    assert "Disallow" not in robots          # was: assert "Disallow: /data/" in robots
    # AI search and answer crawlers are named only in a comment: "User-agent: *" already lets them in.
    assert "User-agent: *\nAllow: /" in robots and "OAI-SearchBot" in robots and "ClaudeBot" in robots
    assert robots.count("User-agent:") == 1
    assert os.path.exists(os.path.join(site, "internships", "massachusetts", "index.html"))


def test_analytics_snippet_comes_from_the_dashboard(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    snippet = "<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{}'></script>"
    (tmp_path / "index.html").write_text(f"<html><body>{snippet}</body></html>", encoding="utf-8")
    assert all(snippet in p["html"] for p in seo_pages.build(site))
    (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
    assert all("cloudflareinsights" not in p["html"] for p in seo_pages.build(site))


def test_visit_counter_comes_from_the_dashboard_too(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    counter = '<script defer src="/js/count.js"></script>'
    beacon = "<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{}'></script>"
    (tmp_path / "index.html").write_text(f"<html><body>{counter}\n{beacon}</body></html>", encoding="utf-8")
    pages = seo_pages.build(site)
    assert pages and all(counter in p["html"] and beacon in p["html"] for p in pages)


def test_field_and_state_slugs_never_collide():
    states = {seo_pages.state_slug(k) for k in seo_pages.US_STATES}
    assert not states & {seo_pages.field_slug(t) for t in seo_pages.FIELD_TITLES}
    assert "for" not in states


def test_dashboard_links_open_on_the_page_topic(tmp_path):
    # Three aerospace roles, so the major's page shows enough the mechanical page does not to be a
    # page of its own (seo_pages.same_list); with one it would be folded into the field page.
    site = _site(tmp_path, {"MA": [_row(i) for i in range(15)] + [_row(15 + i, tags=("aerospace",)) for i in range(3)]},
                 majors=[{"name": "Mechanical Engineering", "tags": ["mechanical", "aerospace", "other"], "level": "undergrad"}])
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    assert 'href="/?field=mechanical"' in pages["/internships/mechanical-engineering/"]
    assert 'href="/?state=MA"' in pages["/internships/massachusetts/"]
    assert 'href="/?field=mechanical&amp;state=MA"' in pages["/internships/mechanical-engineering/massachusetts/"]
    assert 'href="/?field=mechanical,aerospace"' in pages["/internships/for/mechanical-engineering-majors/"]
    # Every listing page offers the extension through the site's own install page.
    assert 'The free <a href="/install.html?from=landing-page">Auto-Apply extension</a>' in pages["/internships/massachusetts/"]
    # docs/js/app.js takes only values shaped like these; anything else would open an empty list.
    assert all(re.fullmatch(r"[a-z_]{2,32}", t) for t in seo_pages.FIELD_TITLES)
    # was: every key of US_STATES itself. The Canada and metro pages send the dashboard their provinces.
    assert all(re.fullmatch(r"[A-Z]{2}|remote|Canada", v) for k in seo_pages.US_STATES
               for v in seo_pages._dash_state(k).split(","))


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
    assert {"/", "/internships/", "/internships/massachusetts/"} <= set(live)
    assert live["/internships/massachusetts/"] == "2026-09-22" and live["/install.html"] == ""
    assert seo_pages.live_paths(os.path.join(site, "missing.xml")) == {}


def test_lastmod_follows_the_listings_and_hubs_carry_no_one_item_breadcrumb(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    pages = seo_pages.build(site)
    seo_pages.write(site, pages)
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    # The newest listing on the page was first seen 2026-09-22, whatever day the build runs.
    assert "<loc>https://internscout.org/internships/massachusetts/</loc><lastmod>2026-09-22</lastmod>" in sitemap
    assert "<loc>https://internscout.org/install.html</loc></url>" in sitemap
    html = {p["path"]: p["html"] for p in pages}
    # The hub carries the Organization and WebSite blocks since 2026-10-02, but still no breadcrumb.
    assert "BreadcrumbList" not in html["/internships/"]      # was: "application/ld+json" not in ...
    assert '"@type": "Organization"' in html["/internships/"]
    assert "BreadcrumbList" in html["/internships/massachusetts/"]   # was: "application/ld+json" in ...


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
    assert 'href="/?state=MA&amp;company=Big%20Co"' in own
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


def test_spellings_of_one_employer_share_a_page_and_a_role_counts_once(tmp_path):
    a = [_row(i, company_name="Boeing") for i in range(8)]
    b = [_row(20 + i, company_name="The Boeing Company") for i in range(4)]
    dup = [_row(40, company_name="The Boeing Company", title=a[0]["title"], regions=a[0]["regions"])]  # second board
    site = _site(tmp_path, {"MA": a + b + dup})
    pages = {p["path"]: p for p in seo_pages.build(site)}
    assert "/internships/at/the-boeing-company/" not in pages
    boeing = pages["/internships/at/boeing/"]
    # was: "Boeing Internships – 12 Open Now". Since 2026-10-01 the title names the term most roles share.
    assert len(boeing["items"]) == 12 and "Boeing Internships (Summer 2027) – 12 Open" in boeing["html"]
    assert "company=Boeing&amp;company=The%20Boeing%20Company" in boeing["html"]
    assert '<a href="/internships/at/boeing/">The Boeing Company</a>' in pages["/internships/massachusetts/"]["html"]
    assert seo_pages.employer_key("Magna International") == seo_pages.employer_key("Magna")
    assert seo_pages.employer_key("Booz Allen Hamilton") == seo_pages.employer_key("Booz Allen")
    assert seo_pages.employer_key("Bank of America") == "bank of america"


def test_a_work_study_board_gets_no_employer_page(tmp_path):
    rows = [_row(i, company_name="Some University", stage=["part_time"], title=f"Library Assistant (FWS) {i}")
            for i in range(12)]
    site = _site(tmp_path, {"MA": rows})
    assert "/internships/at/some-university/" not in _paths(seo_pages.build(site))


def test_new_page_links_to_new_only_and_feeds_every_new_role(tmp_path):
    rows = [_row(i, first_seen="2026-09-22T00:00:00") for i in range(40)]
    rows += [_row(100 + i, first_seen="2026-09-18T00:00:00") for i in range(41)]   # the baseline day
    site = _site(tmp_path, {"MA": rows})
    pages = seo_pages.build(site)
    new = next(p for p in pages if p["path"] == "/internships/new/")
    assert 'href="/?new=1"' in new["html"] and new["feed_limit"] == seo_pages.NEW_FEED   # was: is None
    from internscout import feeds
    seo_pages.write(site, pages)
    feeds.write_all(site, pages)
    xml = open(os.path.join(site, "internships", "new", "feed.xml"), encoding="utf-8").read()
    assert xml.count("<item>") == 40


def test_lastmod_never_goes_back(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i) for i in range(5)]})
    pages = seo_pages.build(site, {"/internships/massachusetts/": "2026-09-30"})
    assert next(p for p in pages if p["path"] == "/internships/massachusetts/")["lastmod"] == "2026-09-30"


def test_term_pay_stage_and_class_year_pages_list_only_what_their_title_says(tmp_path):
    rows = ([_row(i, salary="$25/hr") for i in range(30)]                               # Summer 2027, paid
            + [_row(100 + i, term="Spring 2027", stage=["co_op"]) for i in range(26)]    # co-ops
            + [_row(200 + i, term=None, years=["first_year", "sophomore"]) for i in range(26)]
            + [_row(300 + i, term="Fall 2027", stage=["research"]) for i in range(24)])  # below MIN_KIND
    pages = {p["path"]: p for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    for path in ("/internships/summer-2027/", "/internships/spring-2027/", "/internships/paid/",
                 "/internships/co-op/", "/internships/for-freshmen/", "/internships/for-sophomores/"):
        assert path in pages, path
    assert "/internships/fall-2027/" not in pages and "/internships/research/" not in pages
    assert len(pages["/internships/summer-2027/"]["items"]) == 30
    assert all(x["stage"] == ["co_op"] for x in pages["/internships/co-op/"]["items"])
    assert len(pages["/internships/for-freshmen/"]["items"]) == 26          # only postings that say so
    assert "<title>Summer 2027 Internships – 30 Open Now | InternScout</title>" in pages["/internships/summer-2027/"]["html"]
    # The co-op page's opening doesn't claim "from internships to co-ops and research".
    assert "26 open student roles that are co-ops." in pages["/internships/co-op/"]["html"]
    # Each opens the dashboard on the matching filter, and the hub links every one.
    assert 'href="/?stage=co_op"' in pages["/internships/co-op/"]["html"]
    assert 'href="/?year=first_year"' in pages["/internships/for-freshmen/"]["html"]
    assert 'href="/?paid=1"' in pages["/internships/paid/"]["html"]
    assert all(f'href="{p}"' in pages["/internships/"]["html"]
               for p in ("/internships/summer-2027/", "/internships/paid/", "/internships/for-sophomores/"))


def _build_in_new_python(site: str, seed: int) -> dict[str, bytes]:
    """Build the site in a fresh interpreter with the given hash seed; every file it holds, as bytes."""
    import subprocess
    import sys
    backend = os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__)))
    subprocess.run([sys.executable, "-m", "internscout.seo_pages", site], cwd=backend, check=True,
                   capture_output=True, env=dict(os.environ, PYTHONHASHSEED=str(seed)))
    out = {}
    for folder, _, names in os.walk(site):
        for n in names:
            path = os.path.join(folder, n)
            with open(path, "rb") as f:
                out[os.path.relpath(path, site)] = f.read()
    return out


def test_two_builds_are_identical(tmp_path):
    # Two deploys of the same data wrote ~150 different index.html and every feed.xml: counts over
    # sets tied in hash order (which Python changes per run), ties in sorts kept arrival order, and
    # feeds and the 404 page were dated by the clock. Every tie here is deliberate: one employer's
    # roles spread evenly over four fields and three states, all posted and found at the same moment.
    import shutil
    tags = ("mechanical", "civil", "electrical", "aerospace")
    rows = [_row(i, tags=tags, company_name="Tie Co" if i < 12 else f"Co {i % 7}",
                 posted_at="2026-09-20T00:00:00", first_seen="2026-09-21T00:00:00") for i in range(60)]
    base = _site(tmp_path / "base", {"MA": rows, "NY": rows[:30], "CT": rows[:30], "remote": rows[30:]},
                 majors=[{"name": "Engineering", "tags": list(tags), "level": "undergrad"}])
    builds = []
    for seed in (1, 2, 3):
        site = str(tmp_path / f"b{seed}")
        shutil.copytree(base, site)
        builds.append(_build_in_new_python(site, seed))
    assert any(p.endswith("feed.xml") for p in builds[0]) and len(builds[0]) > 20
    # Builds a second apart would differ by a clock date; three quick ones may not, so check the
    # dates themselves: every one is the data's generated_at (_site: 2026-09-23 10:00 UTC).
    feed = builds[0][os.path.join("internships", "massachusetts", "feed.xml")].decode()
    assert "<lastBuildDate>Wed, 23 Sep 2026 10:00:00 +0000</lastBuildDate>" in feed
    assert b"Updated September 23, 2026." in builds[0]["404.html"]
    for other in builds[1:]:
        assert other.keys() == builds[0].keys()
        assert [p for p in builds[0] if other[p] != builds[0][p]] == []


def test_a_major_showing_what_a_field_page_shows_is_folded_into_it(tmp_path):
    # /internships/health/, /for/nursing-majors/ and /for/nutrition-majors/ showed the same 40 postings
    # as three canonical pages: the majors pulled in a few older roles that never made the first 40,
    # so their full lists differed and the exact-match fold never fired.
    health = [_row(i, tags=("health",)) for i in range(45)]
    older = [_row(100 + i, tags=("nutrition_x",), posted_at="2025-01-01T00:00:00") for i in range(3)]
    newer = [_row(200 + i, tags=("classics_x",), posted_at="2026-09-24T00:00:00") for i in range(4)]
    sport = [_row(300 + i, tags=("sport_x",), posted_at="2026-09-24T00:00:00") for i in range(5)]
    site = _site(tmp_path, {"MA": health + older + newer + sport}, majors=[
        {"name": "Nutrition", "tags": ["health", "nutrition_x"], "level": "undergrad"},   # same 40 shown
        {"name": "Classics", "tags": ["health", "classics_x"], "level": "undergrad"},     # 36 of 40 (90%)
        {"name": "Sport", "tags": ["health", "sport_x"], "level": "undergrad"}])          # 35 of 40
    pages = seo_pages.build(site)
    by_path = {p["path"]: p["html"] for p in pages}
    assert "/internships/for/nutrition-majors/" not in by_path
    assert "/internships/for/classics-majors/" not in by_path
    assert "/internships/for/sport-majors/" in by_path
    # The merged majors link to the page that shows their roles, and that page names them.
    assert "The page for Classics and Nutrition majors." in by_path["/internships/health/"]
    hub = by_path["/internships/for/"]
    assert hub.count('href="/internships/health/"') == 2 and 'href="/internships/for/sport-majors/"' in hub
    seo_pages.write(site, pages)
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "nutrition-majors" not in sitemap and "classics-majors" not in sitemap and "sport-majors" in sitemap
    # A page is never folded into a smaller one: the sport_x field page shows 5 of Sport's 40.
    assert seo_pages.same_list(frozenset("abcde"), frozenset("abcdefghij")) is False
    assert seo_pages.same_list(frozenset("abcdefghij"), frozenset("abcdefghi")) is True


def test_json_ld_cannot_be_broken_out_of(tmp_path):
    # Only "</" was escaped, and "<!--<script>" in an employer's name leaves the HTML parser in a state
    # where the real </script> no longer closes the block.
    evil = 'Evil <!--<script>alert(1)</script> & "Co"'
    rows = [_row(i, company_name=evil) for i in range(12)]
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    html = next(h for p, h in pages.items() if p.startswith("/internships/at/") and p != "/internships/at/")
    start = html.index('<script type="application/ld+json">') + len('<script type="application/ld+json">')
    block = html[start:html.index("</script>", start)]
    assert not set("<>&") & set(block)
    assert json.loads(block)["itemListElement"][-1]["name"] == evil


def test_a_placeholder_salary_is_not_pay(tmp_path):
    # 22 open listings said "$0.00 - $999.99 Hour" or "$0.00 /Yr" and were counted, and shown, as paid.
    for salary in ("$0.00 /Yr", "$0.00 - $999.99 Hour", "0", "$0 - $0"):
        x = {"salary": salary, "insights": {"pay": "paid"}}
        assert not seo_pages.is_paid(x) and seo_pages.pay_text(x) == "", salary
    for salary in ("$25/hr", "$20.00 - $30.00 Hour", "$85,000 /Yr"):
        assert seo_pages.is_paid({"salary": salary}) and seo_pages.pay_text({"salary": salary}) == salary
    assert seo_pages.pay_text({"salary": None, "insights": {"pay": "paid"}}) == "Paid"
    rows = [_row(i, salary="$0.00 - $999.99 Hour") for i in range(5)]
    page = next(p for p in seo_pages.build(_site(tmp_path, {"MA": rows})) if p["path"] == "/internships/massachusetts/")
    assert "999.99" not in page["html"] and "list pay" not in page["html"]


def test_a_malformed_listing_is_skipped_not_fatal(tmp_path, capsys):
    # pages.yml deploys only through this build, so one bad row stopped the whole site from deploying.
    good = [_row(i) for i in range(5)] + [_row(5, regions=[{"state": "MA", "kind": "x"}])]   # no "loc": fine
    bad = [_row(10, regions=[{"kind": "x"}]),        # a region naming nothing
           _row(11, company_name=42),
           _row(12, field_tags="mechanical"),
           "not a listing"]
    long_a, long_b = "A" * 150 + " One", "A" * 150 + " Two"                          # past any sane folder name
    rows = good + bad + [_row(20 + i, company_name=long_a) for i in range(10)] + [_row(40 + i, company_name=long_b) for i in range(10)]
    site = _site(tmp_path, {"MA": rows})
    pages = seo_pages.build(site)
    assert "skipped 4 malformed" in capsys.readouterr().err
    ma = next(p for p in pages if p["path"] == "/internships/massachusetts/")
    assert len(ma["items"]) == 26 and "Town 5" not in ma["html"]
    employer = sorted(p["path"] for p in pages if p["path"].startswith("/internships/at/") and p["path"] != "/internships/at/")
    assert len(employer) == 2 and all(len(p.split("/")[3]) <= seo_pages.SLUG_MAX for p in employer)
    seo_pages.write(site, pages)                    # no OSError from a 300-character folder name
    assert seo_pages.slugify("x" * 200) == seo_pages.slugify("x" * 200) != seo_pages.slugify("x" * 201)


def test_new_means_the_same_calendar_week_the_dashboard_counts():
    # fresh() used a rolling 7 x 24 hours and is_new calendar days, so the two counts differed.
    from datetime import datetime, timezone
    now = datetime(2026, 9, 28, 11, tzinfo=timezone.utc)
    assert not seo_pages.fresh({"first_seen": "2026-09-21T20:00:00+00:00"}, now, "2026-09-18")   # 7 days back
    assert seo_pages.fresh({"first_seen": "2026-09-22T01:00:00+00:00"}, now, "2026-09-18")       # 6 days back


def test_employer_pages_answer_when_where_and_pay_from_their_own_roles(tmp_path):
    rows = [_row(i, company_name="Big Co", salary="$38.00", regions=[{"loc": "Denver, Colorado", "kind": "us", "state": "CO"}])
            for i in range(8)]
    rows += [_row(10 + i, company_name="Big Co", term="Winter 2027", salary="$22.50 - $31.50",
                  regions=[{"loc": "Denver, CO", "kind": "us", "state": "CO"}]) for i in range(2)]
    rows += [_row(20 + i, company_name="Big Co", salary="$90,000 a year") for i in range(2)]   # yearly: not an hourly rate
    site = _site(tmp_path, {"MA": rows, "CO": []})
    h = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/at/big-co/")
    assert "<title>Big Co Internships (Summer 2027) – 12 Open | InternScout</title>" in h
    assert "Listed pay $22.50–$38/hour." in h
    assert "<dt>Listed pay</dt><dd>$22.50 to $38 an hour, on 10 of 12 roles</dd>" in h
    facts = h.split('<dl class="facts">')[1].split("</dl>")[0]
    assert "Denver, CO (10)" in facts and "Colorado" not in facts       # one place, however it's spelled
    assert "Summer 2027 is the most common start: 10 of the 12 open roles. Others start in Winter 2027." in h
    assert "<h2>Does Big Co pay interns?</h2><p>10 of the 12 open roles list pay, from $22.50 to $38 an hour.</p>" in h


def test_employer_pages_say_so_when_postings_leave_things_out(tmp_path):
    rows = [_row(i, company_name="Quiet Co", term=None) for i in range(10)]
    rows[0]["term"] = "Summer 2027"
    site = _site(tmp_path, {"MA": rows})
    h = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/at/quiet-co/")
    assert "<title>Quiet Co Internships – 10 Open | InternScout</title>" in h      # no term most roles share
    assert "None of the 10 open postings lists pay." in h
    assert "Only 1 of the 10 open roles gives a start term: Summer 2027. The rest don’t say." in h


def test_employer_pages_link_similar_employers_and_field_pages_link_employers(tmp_path):
    a = [_row(i, company_name="Rocket Co", tags=("aerospace",)) for i in range(10)]
    b = [_row(20 + i, company_name="Orbit Co", tags=("aerospace",)) for i in range(12)]
    c = [_row(40 + i, company_name="Bank Co", tags=("finance",)) for i in range(10)]
    site = _site(tmp_path, {"MA": a + b + c})
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    rocket = pages["/internships/at/rocket-co/"]
    assert '<h2>Similar employers</h2><ul><li><a href="/internships/at/orbit-co/">Orbit Co</a>' in rocket
    assert "bank-co" not in rocket.split("Similar employers")[1].split("</section>")[0]
    field = next(h for p, h in pages.items() if "Employers hiring in" in h and "orbit-co" in h)
    assert field.index("/internships/at/orbit-co/") < field.index("/internships/at/rocket-co/", field.index("Employers hiring in"))


def test_place_names_read_the_way_people_write_them():
    name = lambda loc: seo_pages.place_name({"loc": loc})
    assert name("New York, New York, United States") == "New York, NY"
    assert name("Austin, Texas, USA") == "Austin, TX"
    assert name("West Des Moines, Iowa") == "West Des Moines, IA"
    assert name("Denver, CO") == "Denver, CO"
    assert seo_pages.place_name({"kind": "remote", "state": "Remote"}) == "Remote"


def test_an_employer_with_five_roles_gets_a_page(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i, company_name="Five Co") for i in range(5)]
                            + [_row(10 + i, company_name="Four Co") for i in range(4)]})
    paths = _paths(seo_pages.build(site))
    assert "/internships/at/five-co/" in paths and "/internships/at/four-co/" not in paths


# ---- for AI assistants and answer engines (added 2026-10-02)

def _pay_site(tmp_path):
    """30 roles at $20-$49 an hour across six employers, and pay that must never be ranked as hourly:
    yearly salaries, salaries in thousands, and a role only in Canada (Canadian dollars)."""
    rows = [_row(i, company_name=f"Pay Co {i % 6}", salary=f"${20 + i}/hr") for i in range(30)]
    rows += [_row(100 + i, company_name="Salary Co", salary="$150,000 a year") for i in range(5)]
    rows += [_row(200 + i, company_name="Thousands Co", salary="$120k") for i in range(5)]
    canada = [_row(300, company_name="Maple Co", salary="$95/hr",
                   regions=[{"loc": "Toronto, ON", "kind": "canada", "state": "ON"}])]
    return _site(tmp_path, {"MA": rows, "ON": canada})


def _ld_blocks(html):
    return [json.loads(b) for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html)]


def test_hourly_rate_skips_amounts_that_only_look_hourly():
    rate = lambda s: seo_pages.hourly_rate({"salary": s})        # noqa: E731
    # Maven Securities' employer page said "$110 an hour" for a $110k salary.
    for salary in ("$110k", "$95K – $100K", "$80k-$120k", "$75 to $100,", "$60.500", "$90,000 a year",
                   "$6,100 month", "$25/week", "$1,300", "$0.00 - $999.99 Hour"):
        assert rate(salary) is None, salary
    assert rate("$25/hr") == (25, 25) and rate("$22.50 - $31.50") == (22.5, 31.5)
    assert rate("$63.53-$68.41/ hr") == (63.53, 68.41)
    assert seo_pages.hourly_range([{"salary": "$110k"}, {"salary": "$30/hr"}]) == (30, 30, 1)


def test_highest_paying_ranks_clear_hourly_rates_and_leaves_yearly_pay_out(tmp_path):
    site = _pay_site(tmp_path)
    pages = seo_pages.build(site)
    by_path = {p["path"]: p["html"] for p in pages}
    h = by_path["/internships/highest-paying/"]
    assert "<title>Highest-Paying Internships – Up to $49 an Hour Listed | InternScout</title>" in h
    assert "is $49 an hour, at" in h
    # Yearly salaries, salaries in thousands and Canadian dollars are never ranked, nor shown as an hourly figure.
    for absent in ("Salary Co", "Thousands Co", "Maple Co", "$150", "$120", "$95"):
        assert absent not in h.split("<main>")[1].split("How this is counted")[0], absent
    assert "Roles only in Canada (1 with a rate) are left out" in h
    # At most PAY_PER_EMPLOYER roles from one employer: six employers, so 18 in the list.
    jobs = h.split('<ul class="jobs">')[1].split("</ul>")[0]
    assert jobs.count('<li class="job">') == 6 * seo_pages.PAY_PER_EMPLOYER
    # The field table counts the roles that list a rate out of the field's open roles, median of $20-$49.
    assert "30 of 41" in h and "$34.50" in h
    # Employers link to their own pages, and the hub links this one.
    assert '<a href="/internships/at/pay-co-5/">Pay Co 5</a>' in h
    assert 'href="/internships/highest-paying/"' in by_path["/internships/"]
    assert [b["@type"] for b in _ld_blocks(h)] == ["BreadcrumbList"]
    seo_pages.write(site, pages)
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "<loc>https://internscout.org/internships/highest-paying/</loc>" in sitemap


def test_no_highest_paying_page_without_enough_listed_rates(tmp_path):
    rows = [_row(i, salary="$25/hr") for i in range(seo_pages.MIN_PAY_ROLES - 1)]
    rows += [_row(100 + i, salary="$85,000 /Yr") for i in range(20)]
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    assert "/internships/highest-paying/" not in pages
    assert "highest-paying" not in pages["/internships/"] and "highest-paying" not in pages["/about/"]


def test_about_and_compare_answer_first_with_valid_json_ld(tmp_path):
    site = _pay_site(tmp_path)
    pages = seo_pages.build(site)
    by_path = {p["path"]: p["html"] for p in pages}
    about = by_path["/about/"]
    blocks = _ld_blocks(about)
    assert [b["@type"] for b in blocks] == ["BreadcrumbList", "Organization", "WebSite", "FAQPage"]
    faq = {q["name"]: q["acceptedAnswer"]["text"] for q in blocks[3]["mainEntity"]}
    assert faq["Does Auto-Apply submit applications for me?"].startswith("No.")
    assert faq["Is InternScout affiliated with UMass Amherst?"].startswith("No.")
    assert faq["Is InternScout free?"].startswith("Yes.")
    assert "41 open internships, co-ops and research roles from 9 employers in 1 field" in faq["What is InternScout?"]
    assert {"Which majors is InternScout for?", "Where do the listings come from?", "How often is InternScout updated?",
            "How is InternScout different from Simplify or Jobright?"} <= set(faq)
    # The page shows the same answers, each under its own heading.
    assert "<h2>Does Auto-Apply submit applications for me?</h2><p>No." in about
    assert seo_pages.SLOGAN in about and blocks[1]["slogan"] == seo_pages.SLOGAN
    compare = by_path["/compare/"]
    assert _ld_blocks(compare)[0]["@type"] == "BreadcrumbList"
    for fact in ("$39.99/month ($19.99/week, $89.99 for 3 months)", "Turbo $39.99/month ($17.99/week)",
                 "as of October 1, 2026", "Not affiliated with Simplify or Jobright.",
                 "https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing",
                 "https://jobscan.co/blog/jobscan-vs-jobright", "never submits", "Job seekers at every level"):
        assert fact in compare, fact
    seo_pages.write(site, pages)
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "<loc>https://internscout.org/about/</loc>" in sitemap and "<loc>https://internscout.org/compare/</loc>" in sitemap
    # Every page's footer reaches both.
    assert all('href="/about/"' in h and 'href="/compare/"' in h for h in by_path.values())


def test_llms_txt_links_the_key_pages_with_numbers_from_the_data(tmp_path):
    site = _pay_site(tmp_path)
    seo_pages.write(site, seo_pages.build(site))
    short = open(os.path.join(site, "llms.txt"), encoding="utf-8").read()
    full = open(os.path.join(site, "llms-full.txt"), encoding="utf-8").read()
    # llmstxt.org: an H1 name, a blockquote summary, then sections of markdown links.
    assert short.startswith("# InternScout\n\n> InternScout (https://internscout.org) is a free internship search")
    # Counted from this data (41 open, 9 employers, 1 field) and dated from the export, not the clock.
    assert "As of September 23, 2026 it lists 41 open internships, co-ops and research roles from 9 employers in 1 field" in short
    for path in ("/", "/about/", "/compare/", "/internships/highest-paying/", "/internships/", "/internships/at/",
                 "/internships/for/", "/internships/mechanical-engineering/", "/install.html", "/privacy", "/terms",
                 "/llms-full.txt"):
        assert f"](https://internscout.org{path})" in short, path
    assert seo_pages.SLOGAN in short and "never submits" in short and "$4/month" in short
    assert "## Optional" in short
    assert full.startswith("# InternScout\n\n> ")
    assert "- [Mechanical Engineering](https://internscout.org/internships/mechanical-engineering/): 41 open" in full
    assert "the highest is $49 an hour" in full and "Not affiliated with UMass Amherst" in full
    assert "Data as of September 23, 2026." in full
    # Not a page: no sitemap entry, but robots.txt and /about/ point to it.
    assert "llms" not in open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert "https://internscout.org/llms.txt" in open(os.path.join(site, "robots.txt"), encoding="utf-8").read()


def test_nothing_built_names_the_founder(tmp_path):
    # The brand stays one student's, unnamed, on the site and in what answer engines read.
    site = _pay_site(tmp_path)
    pages = seo_pages.build(site)
    seo_pages.write(site, pages)
    texts = [p["html"] for p in pages] + [open(os.path.join(site, n), encoding="utf-8").read()
                                          for n in ("llms.txt", "llms-full.txt", "robots.txt", "404.html")]
    assert not [t[:80] for t in texts if re.search(r"bruce|mcginley", t, re.I)]


def test_the_dashboard_carries_the_same_organization_as_the_landing_pages():
    # docs/index.html is hand-written; its JSON-LD must say what seo_pages.ORGANIZATION and WEBSITE say.
    backend = os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__)))
    html = open(os.path.join(backend, "..", "docs", "index.html"), encoding="utf-8").read()
    blocks = _ld_blocks(html.replace("\n", ""))
    assert len(blocks) == 1
    graph = blocks[0]["@graph"]
    strip = lambda o: {k: v for k, v in o.items() if k != "@context"}          # noqa: E731
    assert graph == [strip(seo_pages.ORGANIZATION), strip(seo_pages.WEBSITE)]
