"""The crawlable landing pages: made only where there is enough to show, safe against whatever a job
board puts in a title, and pointing only at real web links."""
import html as html_mod
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
    # Only 4 usable listings, so nothing but the hubs, and /about/, /compare/ (2026-10-02), /pricing/
    # (2026-10-05) and /digest/ (2026-10-06), is built.
    assert _paths(seo_pages.build(site)) == {"/internships/", "/internships/for/", "/internships/at/", "/about/", "/compare/",
                                             "/pricing/", "/digest/"}
    # was: == {"/internships/", "/internships/for/", "/internships/at/", "/about/", "/compare/"}
    # was: == {..., "/about/", "/compare/", "/pricing/"}


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
    # Every listing page offers the extension through the site's own install page, tagged with the kind
    # of page it is on (2026-10-04; was: ?from=landing-page on every page).
    assert 'The free <a href="/install.html?from=seo-state">Auto-Apply extension</a>' in pages["/internships/massachusetts/"]
    assert 'The free <a href="/install.html?from=seo-field">Auto-Apply extension</a>' in pages["/internships/mechanical-engineering/"]
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
    # was: "open student roles in machine learning and AI," (one sentence with the range; split 2026-10-05)
    assert "open student roles in machine learning and AI. They range from internships to co-ops and research." in html
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
    # was: "Boeing Internships – 12 Open Now". Since 2026-10-01 the title names the term most roles share,
    # and since 2026-10-07 before "Internships", as searches word it. was: "Boeing Internships (Summer 2027)".
    assert len(boeing["items"]) == 12 and "Boeing Summer 2027 Internships – 12 Open" in boeing["html"]
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
    assert "<title>Big Co Summer 2027 Internships – 12 Open | InternScout</title>" in h
    assert "Listed pay $22.50–$38/hour." in h
    # 2026-10-07: what the employer's own careers page doesn't show in one place leads the description.
    desc = h.split('<meta name="description" content="')[1].split('"')[0]
    assert desc.startswith("12 open Big Co internships for Summer 2027 on one page, in Denver, CO")
    assert "Newest posted " in desc and "Updated" not in desc and len(desc) <= 160
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
    # was: "... Up to $49 an Hour Listed | InternScout" (67 characters; fit_title drops "Listed", 2026-10-05)
    assert "<title>Highest-Paying Internships – Up to $49 an Hour | InternScout</title>" in h
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
    # was: == ["BreadcrumbList"]; every page carries the Organization since 2026-10-05.
    assert [b["@type"] for b in _ld_blocks(h)] == ["BreadcrumbList", "Organization"]
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
            "How is InternScout different from Simplify or Jobright?", "How are InternScout's pages made?"} <= set(faq)
    # The editorial disclosure (2026-10-05) says what AI does and does not do, and names nobody.
    assert "no AI writes them" in faq["How are InternScout's pages made?"]
    # The pay answer's median and top leave out roles only in Canada, and it says so (review, 2026-10-02):
    # Maple Co's $95 is a rate, but in Canadian dollars, so the highest is $49.
    pay = faq["How much do internships on InternScout pay?"]
    assert "only in Canada" in pay and "the highest is $49 an hour" in pay
    assert "$4 or $8 a month" in faq["How is InternScout different from Simplify or Jobright?"]
    assert seo_pages.COMPARE_AS_OF in faq["How is InternScout different from Simplify or Jobright?"]
    # The page shows the same answers, each under its own heading.
    assert "<h2>Does Auto-Apply submit applications for me?</h2><p>No." in about
    assert seo_pages.SLOGAN in about and blocks[1]["slogan"] == seo_pages.SLOGAN
    compare = by_path["/compare/"]
    assert _ld_blocks(compare)[0]["@type"] == "BreadcrumbList"
    # was: "Turbo $39.99/month ($17.99/week)"; the 3-month price is from the same source (2026-10-04).
    for fact in ("$39.99/month ($19.99/week, $89.99 for 3 months)", "Turbo $39.99/month ($17.99/week, $89.99 for 3 months)",
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
    for path in ("/", "/about/", "/pricing/", "/compare/", "/internships/highest-paying/", "/internships/", "/internships/at/",
                 "/internships/for/", "/internships/mechanical-engineering/", "/install.html", "/privacy", "/terms",
                 "/llms-full.txt"):
        assert f"](https://internscout.org{path})" in short, path
    assert seo_pages.SLOGAN in short and "never submits" in short and "$4/month" in short
    assert "## Optional" in short
    assert full.startswith("# InternScout\n\n> ")
    assert "- [Mechanical Engineering](https://internscout.org/internships/mechanical-engineering/): 41 open" in full
    assert "the highest is $49 an hour" in full and "Not affiliated with UMass Amherst" in full
    assert "Data as of September 23, 2026." in full
    # Only employers with enough open roles have a page, so llms-full doesn't say every one does (review).
    assert "Every field, state, employer and major with enough open roles has a plain page" in full
    assert "and so are roles only in Canada (paid in Canadian dollars)" in full
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
    # was: == [strip(seo_pages.ORGANIZATION), strip(seo_pages.WEBSITE)]; the Product with its three
    # offers joined them on 2026-10-05, so the prices are machine-readable on the page students land on.
    assert graph == [strip(seo_pages.ORGANIZATION), strip(seo_pages.WEBSITE), strip(seo_pages.PRODUCT)]


# ---- /pricing/ (2026-10-05)

def test_pricing_page_states_every_tier_in_numbers_with_a_product_schema(tmp_path):
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": [_row(i) for i in range(6)]}))}
    pricing = pages["/pricing/"]
    # The allowances are the Worker's own arithmetic: .edu = round(free x multiplier), other = floor(half).
    assert seo_pages.plan_allowance("Supporter") == ({"autofill": 50, "resume_tailor": 20}, {"autofill": 25, "resume_tailor": 10})
    assert seo_pages.plan_allowance("Pro") == ({"autofill": 100, "resume_tailor": 40}, {"autofill": 50, "resume_tailor": 20})
    for text in ("<h2>Free</h2>", "<h2>Supporter</h2>", "<h2>Pro</h2>", "$4<span> a month</span>", "$8<span> a month</span>",
                 "50 Auto-Apply runs and 20 tailored resumes a month with a school .edu email", "25 runs and 10 resumes with any other email",
                 "100 Auto-Apply runs and 40 tailored resumes a month", "12 runs and 5 resumes with any other email",
                 # One tier is picked out, with the badge, and the anchor sits next to the price.
                 'class="tier pick" id="supporter"', "Most popular", "Simplify+ and Jobright Turbo run $39.99 a month. This is $4, for students only.",
                 # The money objections, beside the price, not only in the terms.
                 "No refunds by default.", "The extension never submits.", "Cancel any time.",
                 'href="/?upgrade=supporter"', 'href="/?upgrade=pro"', seo_pages.COMPARE_AS_OF, "not for experienced job seekers"):
        assert text in pricing, text
    assert pricing.count('class="badge"') == 1
    blocks = _ld_blocks(pricing)
    assert [b["@type"] for b in blocks] == ["BreadcrumbList", "Organization", "Product"]
    offers = {o["name"]: o for o in blocks[2]["offers"]}
    assert [(o["price"], o["priceCurrency"]) for o in offers.values()] == [("0", "USD"), ("4", "USD"), ("8", "USD")]
    assert offers["Supporter"]["priceSpecification"] == {"@type": "UnitPriceSpecification", "price": "4", "priceCurrency": "USD", "billingIncrement": 1, "unitCode": "MON"}
    assert "priceSpecification" not in offers["Free"] and blocks[2]["brand"] == {"@id": "https://internscout.org/#organization"}
    # Every page's nav and footer reach it, and so does the FAQ's free answer.
    assert all('<a href="/pricing/">Pricing</a>' in h for h in pages.values())
    assert 'href="/pricing/">Plans and prices</a>' in pages["/about/"]
    assert "I started it during my own internship search" in pages["/about/"]


# ---- titles, descriptions and structured data (the SEO audit of 2026-10-05)

def _head(html, tag):
    return html_mod.unescape(re.search(tag, html, re.S).group(1))


def test_fit_title_keeps_the_subject_and_drops_the_count_then_the_suffix():
    fit = seo_pages.fit_title
    assert fit("Sports Internships – 12 Open") == "Sports Internships – 12 Open | InternScout"
    # The count goes before the suffix does, and nothing is cut mid-word.
    long = "Machine Learning and AI Internships in Vermont"
    assert fit(f"{long} – 120 Open", long) == f"{long} | InternScout"
    # 51 characters on its own: the suffix goes too, and the subject stays whole.
    longest = "Mechanical Engineering Internships in Massachusetts"
    assert fit(f"{longest} – 120 Open", longest) == longest
    longer = "Environmental Science and Engineering Internships in Pennsylvania"
    assert fit(f"{longer} – 26 Open", longer, "Environmental Internships in Pennsylvania") == \
        "Environmental Internships in Pennsylvania | InternScout"
    # No form fits with the suffix: the first that fits without it, else a cut at a word.
    assert fit("Internships for Operations and Information Management Majors – 1,861 Open",
               "Internships for Operations and Information Management Majors") == \
        "Internships for Operations and Information Management Majors"
    cut = fit("Executive Office for U.S. Attorneys and the Office of the U.S. Attorneys Internships")
    assert len(cut) <= seo_pages.TITLE_MAX and cut.endswith("the Office of the")
    assert fit("", "Arts Internships") == "Arts Internships | InternScout"        # an empty form is skipped


def test_fit_description_cuts_at_a_sentence_and_pads_a_short_one():
    fit = seo_pages.fit_description
    long = ("12 open Acxiom internships in Conway, AR and New York. Roles in operations, consulting and data "
            "science and analytics. Updated October 5, 2026. Free, no sign-up.")
    assert len(long) > seo_pages.DESC_MAX
    out = fit(long)
    assert out.endswith("Updated October 5, 2026.") and 110 <= len(out) <= 160
    # "St." is not the end of a sentence; a first sentence that is itself too long ends at a word.
    addr = ("8 open St. Luke's University Health Network internships in Easton, PA - 1872 St Lukes Blvd, "
            "Phillipsburg, NJ - 185 Roseberry St and Allentown, PA - 1110 American Parkway. Roles in health.")
    out = fit(addr)
    assert out.startswith("8 open St. Luke's University Health Network internships in Easton") and out.endswith("…")
    assert len(out) <= 160 and " " not in out[-2:]
    short = "534 open research positions for undergraduates, updated October 5, 2026. Free search, no sign-up."
    out = fit(short)
    assert out == short + " Every role links to the employer's own posting." and 110 <= len(out) <= 160
    # The pad never repeats what the text already says.
    assert fit("Free, no sign-up. Every role links to the employer's own posting.").endswith("Updated several times a day.")
    assert fit(long)[:40] == fit("   " + long.replace(". ", ".  "))[:40]       # whitespace is normalised


def test_every_generated_title_and_description_is_within_a_search_results_limits(tmp_path):
    # A long field name in a long state, long employer names, a Canadian metro and province, and
    # every browse page: all built, and every title 30-60 characters, every description 110-160.
    rows = [_row(i, state="PA", tags=("environmental", "ml")) for i in range(seo_pages.MIN_COMBO)]
    rows += [_row(100 + i, company_name="National Information Solutions Cooperative (NISC)", salary="$25/hr",
                  regions=[{"loc": "Lake Saint Louis, MO", "kind": "us", "state": "MO"}]) for i in range(10)]
    rows += [_row(200 + i, company_name="Executive Office for U.S. Attorneys and the Office of the U.S. Attorneys")
             for i in range(6)]
    rows += [_row(300 + i, salary="$30/hr", years=["first_year"], stage=["research"]) for i in range(30)]
    toronto = [_row(400 + i, regions=[{"loc": "Toronto, ON", "kind": "canada", "state": "ON", "metro": "Toronto"}])
               for i in range(6)]
    waterloo = [_row(500 + i, regions=[{"loc": "Kitchener, ON", "kind": "canada", "state": "ON", "metro": "Waterloo Region"}])
                for i in range(6)]
    site = _site(tmp_path, {"PA": rows, "MA": rows[300:], "MO": [], "ON": toronto + waterloo},
                 majors=[{"name": "Operations and Information Management", "tags": ["ml"], "level": "undergrad"}])
    pages = seo_pages.build(site)
    by_path = {p["path"]: p["html"] for p in pages}
    for path in ("/internships/environmental/pennsylvania/", "/internships/toronto/", "/internships/canada/",
                 "/internships/waterloo-region/", "/internships/ontario/", "/internships/research/",
                 "/internships/for-freshmen/", "/internships/highest-paying/", "/internships/paid/",
                 "/internships/at/national-information-solutions-cooperative-nisc/", "/about/", "/compare/", "/pricing/"):
        assert path in by_path, path
    for path, h in by_path.items():
        title, desc = _head(h, r"<title>(.*?)</title>"), _head(h, r'<meta name="description" content="(.*?)"/>')
        assert 30 <= len(title) <= seo_pages.TITLE_MAX, (path, title)
        assert seo_pages.DESC_MIN <= len(desc) <= seo_pages.DESC_MAX, (path, desc)
        assert title.count(seo_pages.TITLE_SUFFIX) <= 1, (path, title)
    assert "<title>Environmental Internships in Pennsylvania | InternScout</title>" in by_path["/internships/environmental/pennsylvania/"]
    assert "<title>Internships in Toronto – 6 Open | InternScout</title>" in by_path["/internships/toronto/"]
    assert "<title>Research Internships for Undergraduates | InternScout</title>" in by_path["/internships/research/"]
    assert "<title>About InternScout – Free Internship Search | InternScout</title>" in by_path["/about/"]
    assert "<title>InternScout Pricing – Free, Upgrades from $4 | InternScout</title>" in by_path["/pricing/"]
    # The employer description drops places until it fits, rather than being cut mid-address.
    nisc = _head(by_path["/internships/at/national-information-solutions-cooperative-nisc/"], r'<meta name="description" content="(.*?)"/>')
    assert nisc.startswith("10 open National Information Solutions Cooperative (NISC) internships for Summer 2027") and "…" not in nisc


def test_every_page_carries_the_organization_once_with_the_brands_profiles(tmp_path):
    pages = seo_pages.build(_pay_site(tmp_path))
    for p in pages:
        blocks = _ld_blocks(p["html"])
        orgs = [b for b in blocks if b["@type"] == "Organization"]
        assert len(orgs) == 1 and orgs[0] == seo_pages.ORGANIZATION, p["path"]
        if p["items"] is not None:         # a listing page is a CollectionPage of the site
            col = next(b for b in blocks if b["@type"] == "CollectionPage")
            assert col["url"] == "https://internscout.org" + p["path"] and col["name"] == p["h1"]
            assert col["isPartOf"] == {"@id": seo_pages.SITE_ID} and col["dateModified"] == p["lastmod"]
    assert len(seo_pages.ORGANIZATION["sameAs"]) == 7
    assert {"https://mastodon.social/@internscout", "https://x.com/useinternscout",
            "https://www.reddit.com/user/InternScout/"} <= set(seo_pages.ORGANIZATION["sameAs"])


def test_the_field_pages_opening_sentences_are_short(tmp_path):
    # The audit measured the field pages' opening sentence at over 25 words: the count and the range
    # are two sentences now, and the compare lede's "cover every level; InternScout lists..." is two.
    site = _pay_site(tmp_path)
    by_path = {p["path"]: p["html"] for p in seo_pages.build(site)}
    lede = by_path["/internships/mechanical-engineering/"].split('<p class="lede">')[1].split("</p>")[0]
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", lede) if s]
    assert sentences[0] == "41 open student roles in mechanical engineering." and sentences[1].startswith("They range from")
    assert max(len(s.split()) for s in sentences) <= 25
    compare = by_path["/compare/"].split('<p class="lede">')[1].split("</p>")[0]
    assert "every career level. InternScout lists only" in compare
    assert max(len(s.split()) for s in re.split(r"(?<=[.!?])\s+", compare)) <= 25


def test_the_install_page_answers_first_and_is_dated():
    # docs/install.html is hand-written: the audit asked for the answer in the first paragraph, a
    # published and an updated date on the page, and a dated HowTo block; no author, as everywhere.
    backend = os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__)))
    html = open(os.path.join(backend, "..", "docs", "install.html"), encoding="utf-8").read()
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)        # the "was:" comments hold old copies
    main = html.split("<main>")[1]
    first = re.sub(r"<[^>]+>", "", re.search(r"<p[^>]*>(.*?)</p>", main, re.S).group(1))
    assert first.startswith("To install the InternScout Auto-Apply extension") and 40 <= len(first.split()) <= 60
    assert '<time datetime="2026-09-15">' in main and '<time datetime="2026-10-05">' in main
    howto = next(b for b in _ld_blocks(html.replace("\n", "")) if b["@type"] == "HowTo")
    assert howto["datePublished"] == "2026-09-15" and howto["dateModified"] == "2026-10-05"
    assert [s["position"] for s in howto["step"]] == [1, 2, 3] and "author" not in howto
    assert howto["publisher"]["@id"] == seo_pages.ORG_ID
    desc = _head(html, r'<meta name="description" content="(.*?)"/>')
    assert seo_pages.DESC_MIN <= len(desc) <= seo_pages.DESC_MAX


# ---- Auto-Apply on the listing pages (2026-10-04)

def _ats(i, ats=None, host=None):
    """A row as build() loads it (with the keys it is filed under), on applicant tracking system ats,
    applying on that system's own host (ATS_HOSTS below) unless host says otherwise."""
    over = {"ats": ats} if ats else {}
    host = host or (ATS_HOSTS[ats].split("*.")[1].split("/")[0] if ats in ATS_HOSTS else None)
    if host:
        over["apply_url"] = f"https://co{i}.{host}/job/{i}"
    return {**_row(i, **over), "keys": {"MA"}}


def test_an_employer_domain_is_not_counted_even_on_a_supported_ats():
    # A SuccessFactors or Greenhouse board an employer serves from its own domain needs the student to
    # allow that site first, so the page doesn't count it (extension/lib/hosts.js isAtsHost).
    own = [_ats(i, "successfactors", host="careers.qorvo.com") for i in range(5)]
    assert not any(seo_pages.autofills(x) for x in own)
    assert seo_pages.autoapply_card(own, "seo-employer") == ""
    assert seo_pages.autofills(_ats(0, "successfactors"))
    # A lookalike host is not the system's: notmyworkdayjobs.com, or myworkdayjobs.com.evil.example.
    for h in ("notmyworkdayjobs.com", "myworkdayjobs.com.evil.example"):
        assert not seo_pages.autofills(_ats(0, "workday", host=h)), h
    mixed = own + [_ats(10 + i, "workday") for i in range(3)]
    assert "3 of these 8 applications are on Workday, a site" in seo_pages.autoapply_card(mixed, "seo-employer")
    html = seo_pages.listing_rows(mixed, seo_pages.datetime(2026, 9, 23, tzinfo=seo_pages.timezone.utc))
    assert html.count('class="aa"') == 3


def test_autofill_hosts_are_the_extensions():
    # The same list as extension/lib/hosts.js ATS_HOSTS, the hosts Auto-Apply needs no permission for.
    backend = os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__)))
    with open(os.path.join(backend, "..", "extension", "lib", "hosts.js"), encoding="utf-8") as f:
        src = f.read()
    block = re.search(r"export const ATS_HOSTS = \[(.*?)\];", src, re.S).group(1)
    assert set(re.findall(r'"([a-z0-9.-]+)"', block)) == set(seo_pages.AUTOFILL_HOSTS)
    # Every supported system's host is one of them.
    assert all(h.split("*.")[1].split("/")[0] in seo_pages.AUTOFILL_HOSTS for h in ATS_HOSTS.values())


def test_autoapply_card_counts_only_what_the_extension_fills():
    assert seo_pages.autoapply_card([_ats(i, "other") for i in range(6)], "seo-field") == ""
    assert seo_pages.autoapply_card([_ats(i, "icims_site") for i in range(6)], "seo-field") == ""
    rows = ([_ats(i, "greenhouse") for i in range(3)] + [_ats(10 + i, "workday") for i in range(2)]
            + [_ats(20 + i, "other") for i in range(4)] + [_ats(30, "lever")])
    card = seo_pages.autoapply_card(rows, "seo-employer")
    # Workday is named first when the page has it, then by count; a third kind is "another site".
    assert "6 of these 10 applications are on Workday, Greenhouse or another site" in card
    assert "stops at Submit" in card
    assert f'href="{seo_pages.STORE_URL}?utm_source=seo-employer"' in card
    assert 'href="/install.html?from=seo-employer"' in card
    assert card.count('class="cta ext-desk"') == 1 and card.count('class="cta ext-touch"') == 1
    # One kind, and no Workday: the most common one, by name.
    one = seo_pages.autoapply_card([_ats(i, "greenhouse") for i in range(5)], "seo-hub")
    assert "All 5 of these applications are on Greenhouse, a site the free" in one
    # Counted over the rows the page shows (PER_PAGE), not every listing it has.
    many = [_ats(i, "ashby") for i in range(seo_pages.PER_PAGE + 10)]
    assert f"All {seo_pages.PER_PAGE} of these" in seo_pages.autoapply_card(many, "seo-field")
    for word in ("hurry", "only ", "left", "today", "limited", "now"):
        assert word not in card.lower(), word


def test_rows_link_auto_apply_only_on_supported_sites():
    rows = [_ats(0, "workday"), _ats(1, "other"), _ats(2, "icims_site"), _ats(3)]
    html = seo_pages.listing_rows(rows, seo_pages.datetime(2026, 9, 23, tzinfo=seo_pages.timezone.utc),
                                  src="seo-state")
    jobs = html.split("</li>")
    assert sum('class="aa"' in j for j in jobs) == 1
    workday = next(j for j in jobs if "Mechanical Intern 0" in j)
    assert '<a class="aa" href="/install.html?from=seo-state-row">Auto-Apply this</a>' in workday
    # Internal links only: the rows never repeat the store link.
    assert "chromewebstore" not in html


def test_employer_page_offers_auto_apply_with_its_own_tag(tmp_path):
    rows = [_row(i, company_name="Big Co", ats="workday", apply_url=f"https://bigco.wd1.myworkdayjobs.com/job/{i}")
            for i in range(seo_pages.MIN_EMPLOYER)]
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    own = pages["/internships/at/big-co/"]
    assert "utm_source=seo-employer" in own and "stops at Submit" in own
    assert "install.html?from=seo-employer-row" in own
    assert f"All {seo_pages.MIN_EMPLOYER} of these applications are on Workday" in own
    # The phone/tablet switch is CSS only, the same media query as install.html.
    assert ".ext-touch{display:none}@media (pointer:coarse) and (hover:none){.ext-desk{display:none}" in own
    assert '<a href="/install.html">Auto-Apply (free)</a>' in own
    assert "utm_source=seo-state" in pages["/internships/massachusetts/"]
    assert "utm_source=seo-hub" in pages["/internships/new/"]


def test_no_auto_apply_card_where_no_listing_is_on_a_supported_site(tmp_path):
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": [_row(i) for i in range(6)]}))}
    ma = pages["/internships/massachusetts/"]
    assert "aa-card\"" not in ma and "chromewebstore" not in ma and 'class="aa"' not in ma
    assert 'href="/install.html?from=seo-state"' in ma          # the quiet follow line stays


def test_compare_and_about_state_the_free_allowance_in_numbers(tmp_path):
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": [_row(i) for i in range(6)]}))}
    words = "25 Auto-Apply runs and 10 tailored resumes a month with a school .edu email (12 and 5 otherwise)"
    assert seo_pages.FREE_WORDS == words
    for path in ("/compare/", "/about/"):
        assert words in pages[path], path
        assert "doubl" not in pages[path].split("<main>")[1], path
    assert "Resume AI" in pages["/compare/"]


# The host each supported "ats" applies on, as extension/manifest.json host_permissions writes it.
ATS_HOSTS = {
    "workday": "https://*.myworkdayjobs.com/*", "greenhouse": "https://*.greenhouse.io/*",
    "oracle": "https://*.oraclecloud.com/*", "icims": "https://*.icims.com/*",
    "ashby": "https://*.ashbyhq.com/*", "lever": "https://*.lever.co/*",
    "eightfold": "https://*.eightfold.ai/*", "smartrecruiters": "https://*.smartrecruiters.com/*",
    "successfactors": "https://*.successfactors.com/*", "taleo": "https://*.taleo.net/*",
    "bamboohr": "https://*.bamboohr.com/*", "rippling": "https://*.rippling.com/*",
    "jazzhr": "https://*.applytojob.com/*", "workable": "https://*.workable.com/*",
    "jobvite": "https://*.jobvite.com/*", "recruitee": "https://*.recruitee.com/*",
    "adp": "https://*.adp.com/*", "paylocity": "https://*.paylocity.com/*",
}


def test_supported_ats_are_the_extensions_own_hosts():
    # A page must not offer Auto-Apply on a site the extension needs an optional permission for.
    backend = os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__)))
    with open(os.path.join(backend, "..", "extension", "manifest.json"), encoding="utf-8") as f:
        hosts = set(json.load(f)["host_permissions"])
    assert set(ATS_HOSTS) == seo_pages.SUPPORTED_ATS
    assert not [k for k, h in ATS_HOSTS.items() if h not in hosts]
    assert not {"other", "icims_site"} & seo_pages.SUPPORTED_ATS


# ---- the page's own data as a chart (2026-10-05, the SEO audit's g_multimodal)

def test_listing_pages_carry_a_chart_of_their_own_numbers(tmp_path):
    rows = {"MA": [_row(i) for i in range(8)], "CA": [_row(100 + i) for i in range(5)]}
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, rows))}
    field = pages["/internships/mechanical-engineering/"]
    # An <img> with alt text that states the same numbers the bars show.
    m = re.search(r'<figure class="chart"><img src="data:image/svg\+xml[^"]*" alt="([^"]+)"', field)
    assert m, "no chart on the field page"
    assert m.group(1).startswith("Bar chart of the 13 open roles on this page by state: ")
    assert "Massachusetts 8" in m.group(1) and "California 5" in m.group(1)
    assert "Where these 13 roles are" in field
    # A state page has one place, so it compares employers instead.
    assert "by employer" in pages["/internships/massachusetts/"] or 'class="chart"' not in pages["/internships/massachusetts/"]


def test_no_chart_when_there_is_nothing_to_compare():
    one_place = [{**_row(i), "keys": {"MA"}} for i in range(5)]
    assert seo_pages.chart_figure(one_place) == ""                       # one state: no bars to compare
    two = one_place + [{**_row(9), "keys": {"CA"}}]
    fig = seo_pages.chart_figure(two)
    assert 'alt="Bar chart of the 6 open roles on this page by state: Massachusetts 5, California 1."' in fig
    # Eight employers in one state: six bars, and the other two said in the alt and caption.
    many = [{**_row(i, company_name=f"Co {i}"), "keys": {"MA"}} for i in range(8)]
    dim, pairs = seo_pages.chart_counts(many, "MA")
    assert dim == "employer" and len(pairs) == 8
    fig = seo_pages.chart_figure(many, "MA")
    assert fig.count("%3Crect") == 6 and "; 2 more at 2 other employers." in fig and "Not shown: 2 more at 2 other employers." in fig


# ---- /internships/by-the-numbers/ and the listing pages' questions (2026-10-05)

def test_by_the_numbers_states_the_headline_figures_dated_with_a_dataset_block(tmp_path):
    site = _pay_site(tmp_path)
    pages = seo_pages.build(site)
    by_path = {p["path"]: p["html"] for p in pages}
    h = by_path[seo_pages.NUMBERS_PATH]
    # Counted from this data (41 open, 9 employers, 1 field) and dated from the export, not the clock.
    assert "As of September 23, 2026, InternScout lists 41 open internships, co-ops and research roles from 9 employers in 1 field." in h
    assert "<dt>Open roles</dt><dd>41</dd>" in h and "<dt>Employers</dt><dd>9</dd>" in h
    assert "1 of the 50 US states and 1 Canadian province or territory" in h
    # Pay is pay_report's, which leaves out the Canada-only role (Maple Co's $95), and says so.
    assert "the median is $34.50 an hour and the highest is $49 an hour, as of September 23, 2026." in h
    assert "Roles only in Canada (1 role with a rate) are left out" in h
    assert ('The one field, by open roles on September 23, 2026: <a href="/internships/mechanical-engineering/">'
            'Mechanical Engineering</a> (41).</p>') in h
    assert 'Open roles by US state on September 23, 2026: <a href="/internships/massachusetts/">Massachusetts</a> (40).' in h
    blocks = _ld_blocks(h)
    assert [b["@type"] for b in blocks] == ["BreadcrumbList", "Dataset", "Organization"]
    data = blocks[1]
    assert data["dateModified"] == "2026-09-23" and data["creator"] == {"@id": seo_pages.ORG_ID}
    measured = {v["name"]: v["value"] for v in data["variableMeasured"]}
    assert measured["Open roles"] == 41 and measured["Employers"] == 9 and measured["Roles in Canada"] == 1
    # Linked from the hub, from /about/'s size answer and from llms.txt's main pages.
    assert 'href="/internships/by-the-numbers/"' in by_path["/internships/"]
    about = by_path["/about/"]
    faq = {q["name"]: q["acceptedAnswer"]["text"] for q in _ld_blocks(about)[3]["mainEntity"]}
    assert faq["How big is InternScout?"].startswith("As of September 23, 2026, 41 open internships")
    assert '<a href="/internships/by-the-numbers/">InternScout by the numbers</a>' in about
    seo_pages.write(site, pages)
    short = open(os.path.join(site, "llms.txt"), encoding="utf-8").read()
    assert "- [InternScout by the numbers](https://internscout.org/internships/by-the-numbers/)" in short.split("## Browse")[0]


def test_no_by_the_numbers_page_on_a_handful_of_listings(tmp_path):
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": [_row(i) for i in range(6)]}))}
    assert seo_pages.NUMBERS_PATH not in pages
    assert "by-the-numbers" not in pages["/internships/"] and "by-the-numbers" not in pages["/about/"]
    # The size answer is still there, without the link.
    assert "<h2>How big is InternScout?</h2><p>As of September 23, 2026, 6 open" in pages["/about/"]


def _faq(html):
    """The FAQPage block's (question, answer) pairs, and the visible section's, unescaped."""
    block = next(b for b in _ld_blocks(html) if b["@type"] == "FAQPage")
    ld = [(q["name"], q["acceptedAnswer"]["text"]) for q in block["mainEntity"]]
    sec = html.split('<section class="faq">')[1].split("</section>")[0]
    shown = [(html_mod.unescape(q), html_mod.unescape(a)) for q, a in re.findall(r"<h2>(.*?)</h2><p>(.*?)</p>", sec)]
    return ld, shown


def test_field_state_and_combo_pages_answer_their_questions_in_text_and_json_ld(tmp_path):
    site = _pay_site(tmp_path)
    by_path = {p["path"]: p for p in seo_pages.build(site)}
    field = by_path["/internships/mechanical-engineering/"]
    ld, shown = _faq(field["html"])
    assert ld == shown and 3 <= len(ld) <= 4
    assert all(0 < len(a) <= seo_pages.FAQ_ANSWER_MAX for _, a in ld)
    answers = dict(ld)
    n = len(field["items"])
    assert answers["How many mechanical engineering internships are open right now?"] == \
        f"{n} open mechanical engineering internships, co-ops and research roles as of September 23, 2026, from 9 employers."
    # Every employer has 5 roles here, so the tie goes to the name (top()).
    assert answers["Which employers are hiring mechanical engineering interns?"] == (
        "The employers with the most open mechanical engineering roles are Pay Co 0, Pay Co 1, Pay Co 2, Pay Co 3 "
        "and Pay Co 4, of 9 employers hiring.")
    # The hourly range leaves out the Canada-only role's $95 (Canadian dollars), and says so.
    assert answers["Do mechanical engineering internships pay?"] == (
        "41 of the 41 open roles (100%) list pay or say they are paid. Listed hourly rates run from $20 to $49 an "
        "hour, leaving out roles only in Canada.")
    assert answers["Where are mechanical engineering internships?"] == "The open roles are in Massachusetts (40) and Ontario (1)."
    many = [{**_row(i, state=st), "keys": {st}} for i, st in enumerate(["MA", "NY", "CT", "RI", "NH", "VT", "ME"])]
    assert dict(seo_pages.listing_faq(many, "mechanical", None, "x"))["Where are mechanical engineering internships?"]         .endswith("and 2 more states.")
    # After the chart, before the follow lines.
    h = field["html"]
    assert h.index('class="chart"') < h.index('<section class="faq">') < h.index('class="follow"')
    # A state page: its own cities, one spelling each; the province page's rates are Canadian dollars.
    ma, _ = _faq(by_path["/internships/massachusetts/"]["html"])
    assert dict(ma)["How many internships in Massachusetts are open right now?"].startswith("40 open internships")
    assert dict(ma)["Where are internships in Massachusetts?"].startswith("The open roles are in Town 0 (1),")


def test_canadian_pages_say_their_rates_are_canadian_dollars(tmp_path):
    rows = [_row(i, salary=f"${25 + i}/hr", regions=[{"loc": "Toronto, Ontario, Canada", "kind": "canada", "state": "ON",
                                                      "metro": "Toronto"}]) for i in range(6)]
    by_path = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"ON": rows}))}
    ld, shown = _faq(by_path["/internships/toronto/"])
    assert ld == shown
    answers = dict(ld)
    assert answers["Do internships in Toronto pay?"].endswith("from $25 to $30 an hour, in Canadian dollars.")
    # "Toronto, Ontario, Canada" is just Toronto on the Toronto page, and "Toronto, ON" on the Canada page.
    assert answers["Where are internships in Toronto?"] == "The open roles are in Toronto (6)."
    assert dict(_faq(by_path["/internships/canada/"])[0])["Where are internships in Canada?"] == "The open roles are in Toronto, ON (6)."


def test_employer_pages_carry_no_faq_page_block(tmp_path):
    rows = [_row(i, company_name="Big Co") for i in range(seo_pages.MIN_EMPLOYER)]
    by_path = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    own = by_path["/internships/at/big-co/"]
    assert "<h2>Does Big Co pay interns?</h2>" in own                     # its own questions, as before
    assert "FAQPage" not in own
    assert "FAQPage" in by_path["/internships/massachusetts/"]


def test_no_question_without_an_answer():
    # One employer and no places: no list of employers to name, and nowhere to say.
    items = [{**_row(i, company_name="Solo Co", regions=[]), "keys": {"remote"}} for i in range(5)]
    qa = dict(seo_pages.listing_faq(items, None, "remote", "September 23, 2026"))
    assert qa["Which employers are hiring remote interns?"] == "All 5 open roles are at Solo Co."
    assert qa["Do remote internships pay?"] == "None of the 5 open postings lists pay or says it is paid."
    assert not any(q.startswith("Where") for q in qa)
    assert seo_pages.listing_faq([], "swe", None, "September 23, 2026") == []


# ---- the weekly email's sign-up forms and /digest/ (2026-10-06)

FORM = "https://buttondown.com/api/emails/embed-subscribe/internscout-test"


def _config(tmp_path, action):
    """A dashboard index.html with the analytics tags and CONFIG.digest as docs/index.html writes it."""
    (tmp_path / "index.html").write_text(
        "<html><head><script>\nwindow.CONFIG = {\n"
        '    // paste "https://buttondown.com/api/emails/embed-subscribe/YOUR-BUTTONDOWN-USERNAME" here\n'
        "    // Keep CONFIG.digest.formAction in double quotes: digest: { formAction: \"https://evil.example/\" }\n"
        f'    digest: {{ provider: "Buttondown", formAction: "{action}" }},\n'
        "};\n</script>\n"
        '<script defer src="/js/count.js"></script></head><body></body></html>', encoding="utf-8")


def _email_site(tmp_path, action):
    # mechanical: 8 open, 6 of them new this week; nursing: 6 open, 2 new (below DIGEST_MIN_NEW).
    rows = [_row(i) for i in range(6)]
    rows += [_row(10 + i, first_seen="2026-09-10T00:00:00", posted_at="2026-09-01T00:00:00") for i in range(2)]
    rows += [_row(30 + i, tags=("nursing",), title=f"Nursing Extern {i}") for i in range(2)]
    rows += [_row(40 + i, tags=("nursing",), title=f"Nursing Extern {40 + i}", first_seen="2026-09-10T00:00:00",
                  posted_at="2026-09-01T00:00:00") for i in range(4)]
    site = _site(tmp_path, {"MA": rows})
    _config(tmp_path, action)
    return site


def test_the_form_address_is_read_from_the_dashboards_config_line_only(tmp_path):
    assert seo_pages.digest_form_action(str(tmp_path)) == ""                 # no index.html at all
    for action, want in (("", ""), ("  ", ""), ("http://buttondown.com/x", ""), ("javascript:alert(1)", ""),
                         (FORM, FORM)):
        _config(tmp_path, action)
        assert seo_pages.digest_form_action(str(tmp_path)) == want, action
    # The real docs/index.html still has the line where this reads it, so editing the dashboard's config
    # can't silently switch every landing page's form off.
    docs = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(seo_pages.__file__))), "..", "docs")
    assert seo_pages._DIGEST_ACTION.search(open(os.path.join(docs, "index.html"), encoding="utf-8").read())


def test_the_archive_is_worked_out_from_the_form_address():
    # The same cases as tests/site/core.test.mjs checks for IS.digestArchive.
    assert seo_pages.digest_archive(FORM) == "https://buttondown.com/internscout-test/archive/"
    assert seo_pages.digest_archive("https://buttondown.email/api/emails/embed-subscribe/intern_scout-2/") == \
        "https://buttondown.com/intern_scout-2/archive/"
    for no in ("", "http://buttondown.com/api/emails/embed-subscribe/x", "https://example.com/api/emails/embed-subscribe/x",
               "https://buttondown.com/api/emails/embed-subscribe/x/../y", 'https://buttondown.com/api/emails/embed-subscribe/a"onmouseover=x'):
        assert seo_pages.digest_archive(no) == "", no


def test_no_page_has_a_form_while_the_address_is_empty(tmp_path):
    site = _email_site(tmp_path, "")
    pages = seo_pages.build(site)
    assert not [p["path"] for p in pages if "<form" in p["html"] or "Last Monday" in p["html"]]
    digest = next(p for p in pages if p["path"] == "/digest/")
    assert '<meta name="robots" content="noindex"/>' in digest["html"] and 'rel="canonical"' not in digest["html"]
    assert "Sign-ups for the email aren't open yet" in digest["html"] and 'href="/internships/new/"' in digest["html"]
    seo_pages.write(site, pages)
    assert "/digest/" not in open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()


def test_with_an_address_the_field_pages_new_page_and_digest_page_have_the_form(tmp_path):
    site = _email_site(tmp_path, FORM)
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    with_form = {path for path, html in pages.items() if "<form" in html}
    assert with_form == {"/internships/mechanical-engineering/", "/internships/nursing/", "/internships/new/", "/digest/"}
    archive = '<a href="https://buttondown.com/internscout-test/archive/" target="_blank" rel="noopener">See last Monday\'s email</a>'
    for path in with_form:
        html = pages[path]
        form = re.search(r'<form class="digest".*?</form>', html, re.S).group(0)
        assert f'action="{FORM}" method="post" target="_blank"' in form
        assert 'name="email" required' in form and '<input type="hidden" name="embed" value="1"/>' in form
        assert archive in form and 'href="/privacy#digest"' in form
        assert "checked" not in form, "nothing is ticked for the student"
        assert html.count("<form") == 1
    # A field page offers its own field as one unticked tag, as the dashboard's form sends it; the others none.
    assert '<input type="checkbox" name="tag" value="mechanical"/> Save mechanical engineering with my subscription' \
        in pages["/internships/mechanical-engineering/"]
    assert 'name="tag"' not in pages["/internships/new/"] and 'name="tag"' not in pages["/digest/"]
    assert '<h2 id="digest-title">Sign up</h2>' in pages["/digest/"]
    seo_pages.write(site, list(seo_pages.build(site)))
    assert "<loc>https://internscout.org/digest/</loc>" in open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()


def test_the_pitch_quotes_the_emails_own_count_and_never_a_small_one(tmp_path):
    site = _email_site(tmp_path, FORM)
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    d = seo_pages.load(site)
    now = seo_pages._when(d["generated_at"])
    new = seo_pages.new_roles(d, now)
    assert len(new) == 8 and sum("mechanical" in x["field_tags"] for x in new) == 6
    assert "6 new mechanical engineering internships in the last week." in pages["/internships/mechanical-engineering/"]
    # Two new nursing roles is under the email's bar for a section, so no number at all.
    nursing = pages["/internships/nursing/"]
    assert "<form" in nursing and not re.search(r"\b\d+ new nursing", nursing)
    assert "8 new internships in the last week" in pages["/digest/"]
    assert "the most in mechanical engineering." in pages["/digest/"]          # nursing (2) is under the bar
    assert "8 new internships in the last week." in pages["/internships/new/"]


def test_the_new_page_says_why_its_count_differs_from_the_list(tmp_path):
    rows = [_row(i) for i in range(6)]
    rows.append(_row(9, company_name="Company 0", title=rows[0]["title"], regions=rows[0]["regions"]))  # second board
    site = _site(tmp_path, {"MA": rows})
    _config(tmp_path, FORM)
    html = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/new/")
    assert "6 new internships in the last week, each role counted once even when an employer posted it twice." in html


def test_the_digest_page_has_no_number_in_a_quiet_week(tmp_path):
    rows = [_row(i, first_seen="2026-09-10T00:00:00", posted_at="2026-09-01T00:00:00") for i in range(5)] + [_row(9)]
    site = _site(tmp_path, {"MA": rows})
    _config(tmp_path, FORM)
    pages = {p["path"]: p["html"] for p in seo_pages.build(site)}
    assert "/internships/new/" not in pages
    lede = re.search(r'<p class="lede">(.*?)</p>', pages["/digest/"]).group(1)
    assert lede.startswith("One free email every Monday") and "new internships" not in lede


def test_workday_country_state_city_places_read_as_city_and_state():
    # 2026-10-07: "USA-Illinois-Chicago" filled Mars's description; "USA-IL Oak Brook" is Winland Foods'.
    assert seo_pages.place_name({"loc": "USA-Illinois-Chicago"}) == "Chicago, IL"
    assert seo_pages.place_name({"loc": "USA-Arkansas-Ft. Smith"}) == "Ft. Smith, AR"
    assert seo_pages.place_name({"loc": "USA-IL Oak Brook"}) == "Oak Brook, IL"
    assert seo_pages.place_name({"loc": "Denver, Colorado"}) == "Denver, CO"
