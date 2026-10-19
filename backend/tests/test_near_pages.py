"""The 500 "<field> internships near <city>" pages (2026-10-18): exactly ten fields by fifty metros, a
listing counted for a metro only when one of its own locations is inside it, thin pages kept out of
search but still live, and everything a job board wrote escaped."""
import json
import os
import re

from internscout import classify, near_metros as nm, seo_pages

NEAR = seo_pages.NEAR_ROOT


def _row(i, loc="Denver, CO", state="CO", tags=("finance",), kind="us", company=None, **over):
    row = {
        "id": f"n{i}", "company_name": company or f"Northwind {i % 4}", "title": f"Finance Intern {i}",
        "field_tags": list(tags), "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "posted_at": "2026-10-01T00:00:00", "first_seen": "2026-10-01T00:00:00",
        "regions": [{"loc": loc, "kind": kind, "state": state}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": kind == "remote",
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, rows):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    index = {"generated_at": "2026-10-18T10:00:00+00:00", "files": {}}
    by_key = {}
    for r in rows:
        by_key.setdefault({"Remote": "remote", None: "remote"}.get(r["regions"][0]["state"], r["regions"][0]["state"]), []).append(r)
    for key, rs in by_key.items():
        (data / f"{key}.json").write_text(json.dumps(rs), encoding="utf-8")
        index["files"][key] = {"file": f"listings/{key}.json"}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


def _built(site, live=()):
    return {p["path"]: p for p in seo_pages.build(site, set(live), frozenset(), frozenset())}


def _metro(city):
    return next(m for m in nm.METROS if m["city"] == city)


def _path(city, slug):
    return seo_pages.near_path(_metro(city), slug)


def _in(loc, state, kind="us"):
    """The anchor cities a region counts for."""
    return {next(m["city"] for m in nm.METROS if m["cbsa"] == c)
            for c in nm.region_metros({"loc": loc, "state": state, "kind": kind})}


def _main(html):
    """The page's own words: the listing rows (a job board's titles) taken out."""
    body = html.split("<main>")[1].split("</main>")[0]
    return re.sub(r'<ul class="jobs">.*?</ul>', "", body, flags=re.S)


# ---------------------------------------------------------------- the grid

def test_ten_fields_and_fifty_metros_from_the_committed_sources():
    assert len(nm.FIELDS) == 10 and len(nm.METROS) == 50
    assert [f["rank"] for f in nm.FIELDS] == list(range(1, 11))
    assert set(nm.TOWNS) | set(nm.WHOLE_STATE) | set(nm.RADIUS_KIND) == {m["cbsa"] for m in nm.METROS}
    # Every metro's anchor city can match its own name (New York by radius, Washington as the District).
    for m in nm.METROS:
        if m["cbsa"] in nm.WHOLE_STATE or m["cbsa"] in nm.RADIUS_KIND:
            continue
        assert m["city"].lower().replace(".", "") in nm.TOWNS[m["cbsa"]][m["state"]], m["city"]


def test_the_field_mapping_uses_only_tags_classify_gives_and_matches_the_json():
    known = {rule[0] for rule in classify.RULES}
    assert set(nm.FIELD_TAGS) == {f["slug"] for f in nm.FIELDS}
    for f in nm.FIELDS:
        tags = nm.FIELD_TAGS[f["slug"]]
        assert tags and set(tags) <= known, (f["slug"], set(tags) - known)
        assert tuple(f["tags"]) == tags                   # top_degree_fields.json says the same
    assert nm.FIELD_TAGS["education"] == ("education",) and nm.FIELD_TAGS["psychology"] == ("psychology",)
    assert "quant" not in nm.FIELD_TAGS["business"] and "biomedical" in nm.FIELD_TAGS["engineering"]


def test_exactly_the_500_pages_and_a_hub_are_built_even_with_no_listings_near_any(tmp_path):
    built = _built(_site(tmp_path, [_row(i, loc="Boise, ID", state="ID") for i in range(6)]))
    near = {p for p in built if p.startswith(NEAR)}
    want = {seo_pages.near_path(m, f["slug"]) for m in nm.METROS for f in nm.FIELDS}
    assert len(want) == 500 and near == want | {NEAR}
    assert len({nm.metro_slug(m) for m in nm.METROS}) == 50
    assert _path("Washington", "business") == "/internships/near/washington-dc/business/"
    assert _path("St. Louis", "education") == "/internships/near/st-louis/education/"
    assert all(re.fullmatch(r"/internships/near/[a-z0-9-]+/[a-z0-9-]+/", p) for p in want)
    # Nothing else lives under /internships/near/, and no existing kind of page moved there.
    assert all(built[p]["kind"] == "near" for p in want)
    # None of them has a listing, so none is asked into search.
    assert all(built[p]["thin"] and not built[p]["index"] for p in want)


# ---------------------------------------------------------------- which listings are near which city

def test_namesake_towns_in_other_states_never_count():
    assert _in("Portland, OR", "OR") == {"Portland"}
    assert _in("Portland, ME", "ME") == set()
    assert _in("Portland, TN", "TN") == {"Nashville"}          # Sumner County
    assert _in("Portland, CT", "CT") == {"Hartford"}           # Middlesex County
    assert _in("Birmingham, AL", "AL") == {"Birmingham"}
    assert _in("Birmingham, MI", "MI") == {"Detroit"}
    assert _in("Richmond, VA", "VA") == {"Richmond"} and _in("Richmond, CA", "CA") == {"San Francisco"}
    assert _in("Columbus, OH", "OH") == {"Columbus"}
    assert _in("Columbus, IN", "IN") == set() and _in("Columbus, GA", "GA") == set()
    assert _in("Hartford, WI", "WI") == {"Milwaukee"}
    assert _in("Nashville, IN", "IN") == {"Indianapolis"}
    assert _in("Aurora, IL", "IL") == {"Chicago"} and _in("Aurora, CO", "CO") == {"Denver"}
    assert _in("Arlington, TX", "TX") == {"Dallas"} and _in("Arlington, VA", "VA") == {"Washington"}
    assert _in("Pasadena, TX", "TX") == {"Houston"} and _in("Pasadena, CA", "CA") == {"Los Angeles"}
    assert _in("Vancouver, WA", "WA") == {"Portland"}
    assert _in("Vancouver, BC", "BC", "canada") == set()
    # The prefix rule: Fort Washington is a Philadelphia suburb, not Washington or Pittsburgh's Washington, PA.
    assert _in("Fort Washington, PA", "PA") == {"Philadelphia"} and _in("Washington, PA", "PA") == {"Pittsburgh"}
    assert _in("West Palm Beach, FL", "FL") == {"Miami"} and _in("New Boston, NH", "NH") == set()


def test_only_a_named_town_counts_never_a_state_the_country_or_remote():
    assert _in("Colorado", "CO") == set() and _in("State of Colorado, United States of America", "CO") == set()
    assert _in("CO", "CO") == set() and _in("United States", "CO") == set()
    assert _in("Remote, TX", "TX", "remote") == set() and _in("Dallas, TX (Remote)", "TX") == set()
    assert _in("CO, Working at Home - Colorado", "CO") == set()
    assert _in("NJ", "NJ", "nyc_metro") == set() and _in("Hybrid", "NY", "nyc_metro") == set()
    assert _in("Remote", None, "remote") == set()
    # Boulder and Fort Collins are their own metros, not Denver's.
    assert _in("Boulder, CO", "CO") == set() and _in("Fort Collins, CO", "CO") == set()


def test_new_york_is_the_50_mile_radius_and_washington_the_district():
    assert _in("Jersey City, NJ", "NJ", "nyc_metro") == {"New York"}
    assert _in("New York", "NY", "nyc_metro") == {"New York"}
    assert _in("Brooklyn, NY", "NY") == {"New York"}
    assert _in("Rochester, New York", "NY") == set() and _in("Rochester, NY", "NY") == set()
    assert _in("Washington, DC", "DC") == {"Washington"} and _in("DC", "DC") == {"Washington"}
    assert _in("Washington, District of Columbia", "WA") == {"Washington"}
    assert _in("Seattle, Washington", "WA") == {"Seattle"}
    assert _in("Laurel, MD", "MD") == {"Washington", "Baltimore"}       # the one postal town in two metros


def test_the_many_ways_boards_write_a_town():
    for loc in ("Denver, CO, 80205", "Downtown Denver, CO", "US.CO.Denver", "USA - Denver", "Denver CO USA",
                "Hybrid - Denver, CO", "Greater Denver Area", "CO-Denver", "Denver, Colorado, United States"):
        assert _in(loc, "CO") == {"Denver"}, loc
    assert _in("St. Petersburg/Tampa", "FL") == {"Tampa"} and _in("Saint Louis, MO", "MO") == {"St. Louis"}
    assert _in("Ft. Lauderdale, FL", "FL") == {"Miami"} and _in("Fuquay-Varina, NC", "NC") == {"Raleigh"}
    assert _in("5426 Bay Center Dr., Suite 100, Tampa, Florida 33609", "FL") == {"Tampa"}
    assert _in("East Hartford-ETC, CT", "CT") == {"Hartford"}


# ---------------------------------------------------------------- the pages

def _denver_site(tmp_path, n_local=6, extra=()):
    """n_local finance roles in and around Denver, plus roles elsewhere so no other page is the same list."""
    rows = [_row(i, loc=("Denver, CO" if i % 2 else "Lakewood, CO")) for i in range(n_local)]
    rows += [_row(100 + i, loc="Austin, TX", state="TX") for i in range(12)]           # finance elsewhere
    rows += [_row(200 + i, loc="Fort Collins, CO", tags=("mechanical",)) for i in range(12)]  # Colorado, not Denver
    rows += [_row(250 + i, loc="Denver, CO", tags=("mechanical",)) for i in range(8)]         # Denver, not business
    rows += [_row(300, loc="Portland, ME", state="ME", tags=("mechanical",))]
    rows += [_row(301, loc="Colorado", tags=("finance",))]                              # statewide
    rows += [_row(302, loc="Remote", state="Remote", kind="remote", tags=("finance",))]  # US-remote
    return _site(tmp_path, rows + list(extra))


def test_a_city_page_lists_only_its_local_roles_with_real_counts(tmp_path):
    built = _built(_denver_site(tmp_path))
    page = built[_path("Denver", "business")]
    html = page["html"]
    assert len(page["items"]) == 6 and {x["id"] for x in page["items"]} == {f"n{i}" for i in range(6)}
    assert "<h1>Business internships near Denver, CO</h1>" in html
    assert "6 open student roles in business near Denver, CO." in html
    assert "By town: Denver (3) and Lakewood (3)." in html
    # The statewide and the remote role are not among the six, and the remote one is in its own section.
    jobs = html.split('<ul class="jobs">')[1].split("</ul>")[0]
    assert "Finance Intern 301" not in jobs and "Finance Intern 302" not in jobs
    assert "<h2>Remote business roles</h2>" in html and "1 remote business role is open to students anywhere" in html
    # The page says how it counts, and what the field covers.
    assert "Denver-Aurora-Centennial, CO metro area, matched by town name" in html
    assert "Business here means the roles InternScout tags Business, Finance, Accounting" in html
    # Portland, Maine is not near Portland, Oregon.
    assert not built[_path("Portland", "engineering")]["items"]


def test_the_page_links_the_dashboard_the_citys_other_fields_and_the_fields_other_cities(tmp_path):
    built = _built(_denver_site(tmp_path))
    html = built[_path("Denver", "business")]["html"]
    dash = re.search(r'<a class="cta" href="([^"]+)">Search business roles in Colorado on the dashboard</a>', html)
    assert dash and "state=CO" in dash.group(1)
    assert len(re.search(r"field=([^&]+)", dash.group(1)).group(1).split(",")) <= 6   # the dashboard reads six
    for f in nm.FIELDS:
        if f["slug"] != "business":
            assert f'href="{_path("Denver", f["slug"])}"' in html
    for m in nm.METROS:
        if m["city"] != "Denver":
            assert f'href="{seo_pages.near_path(m, "business")}"' in html
    assert f'href="{NEAR}"' in html
    assert 'href="feed.xml"' in html


def test_an_empty_page_says_so_truthfully_and_is_kept_out_of_search(tmp_path):
    built = _built(_denver_site(tmp_path))
    page = built[_path("Fresno", "education")]
    html = page["html"]
    assert page["items"] is None and page["thin"] and not page["index"]
    assert "InternScout has no open education roles with a location near Fresno, CA right now." in html
    assert '<meta name="robots" content="noindex, follow"/>' in html
    assert '<link rel="canonical" href="https://internscout.org/internships/near/fresno/education/"/>' in html
    assert 'href="feed.xml"' not in html and "Each role links straight" not in html
    desc = re.search(r'<meta name="description" content="(.*?)"/>', html).group(1)
    assert desc.startswith("No open education internships near Fresno, CA right now.")


def test_below_the_threshold_a_page_is_noindex_and_out_of_the_sitemap_but_still_built(tmp_path):
    need = seo_pages.NEAR_INDEX_MIN
    assert need == 5
    path = _path("Denver", "business")
    small = _built(_denver_site(tmp_path / "small", need - 1))[path]
    assert small["thin"] and "noindex, follow" in small["html"] and len(small["items"]) == need - 1
    # Under the bar the page lists remote roles too, apart; an indexed page gives only their count.
    assert small["html"].count('<ul class="jobs">') == 2
    site = _denver_site(tmp_path / "enough", need)
    built = _built(site)
    assert built[path]["index"] and not built[path]["thin"] and "noindex" not in built[path]["html"]
    assert built[path]["html"].count('<ul class="jobs">') == 1
    seo_pages.write(site, list(built.values()))
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    held = open(os.path.join(site, seo_pages.HELD_FILE), encoding="utf-8").read()
    assert f"<loc>https://internscout.org{path}</loc>" in sitemap and path not in held
    assert f"<loc>https://internscout.org{NEAR}</loc>" in sitemap
    fresno = _path("Fresno", "education")
    assert f"<loc>https://internscout.org{fresno}</loc>" not in sitemap and fresno in held.splitlines()
    assert os.path.exists(os.path.join(site, "internships", "near", "fresno", "education", "index.html"))
    # One role closing does not drop a page that is already in the live sitemap.
    assert _built(_denver_site(tmp_path / "live", need - 1), live={path})[path]["index"]


def test_one_employers_roles_or_a_list_the_site_already_has_are_not_indexed(tmp_path):
    path = _path("Denver", "business")
    one = [_row(i, loc="Denver, CO", company="Solo Co") for i in range(8)]
    assert _built(_site(tmp_path / "one", one + [_row(100 + i, loc="Austin, TX", state="TX") for i in range(12)]))[path]["thin"]
    # Every finance role in Colorado is in Denver: the near page would be the Colorado page again.
    same = [_row(i, loc="Denver, CO") for i in range(8)] + [_row(100 + i, loc="Austin, TX", state="TX") for i in range(12)]
    built = _built(_site(tmp_path / "same", same))
    assert built["/internships/colorado/"]["index"] and built[path]["thin"]


def test_titles_and_descriptions_come_from_the_pages_own_data(tmp_path):
    built = _built(_denver_site(tmp_path, 12))
    html = built[_path("Denver", "business")]["html"]
    title = re.search(r"<title>(.*?)</title>", html).group(1)
    desc = re.search(r'<meta name="description" content="(.*?)"/>', html).group(1)
    assert title == "Business Internships near Denver: 10+ Open | InternScout"
    assert desc.startswith("12 open business internships for college students near Denver, CO, most for Summer 2027.")
    assert "Hiring now: Northwind" in desc
    # A long field name gives way to its short one before the count does.
    long_ = seo_pages.near_title(nm.field_of("computer-and-information-sciences"), _metro("San Francisco"),
                                 [_row(i) for i in range(120)])
    assert long_ == "Computer Science Internships near San Francisco: 100+ Open"
    for p in built.values():
        if p["kind"] == "near":
            t = re.search(r"<title>(.*?)</title>", p["html"]).group(1)
            d = re.search(r'<meta name="description" content="(.*?)"/>', p["html"]).group(1)
            assert 30 <= len(t) <= seo_pages.TITLE_MAX and seo_pages.DESC_MIN <= len(d) <= seo_pages.DESC_MAX, p["path"]


def test_the_hub_links_every_one_of_the_500_pages_and_is_linked_from_the_browse_hub(tmp_path):
    built = _built(_denver_site(tmp_path))
    hub = built[NEAR]
    assert hub["index"] and "<h1>Internships near 50 US cities</h1>" in hub["html"]
    links = set(re.findall(r'href="(/internships/near/[^"]+/[^"]+/)"', hub["html"]))
    assert links == {p for p in built if p.startswith(NEAR) and p != NEAR}
    assert hub["html"].count("<h2>Near ") == 50
    assert '<a href="/internships/near/denver/business/">Business</a> <span class="n">6</span>' in hub["html"]
    assert f'href="{NEAR}"' in built["/internships/"]["html"]


def test_everything_from_a_job_board_is_escaped_on_the_near_pages(tmp_path):
    evil = [_row(i, loc='Denver, CO', company='Evil & Co "</title><script>x</script>',
                 title='<img src=x onerror=alert(1)>Intern') for i in range(6)]
    evil += [_row(50, loc='<b>Denver</b>, CO', company="Other Co"), _row(51, loc="Lakewood, CO", company="Third Co")]
    built = _built(_denver_site(tmp_path, 0, evil))
    for p in built.values():
        if p["kind"] == "near" or p["path"] == NEAR:
            assert "<script>x" not in p["html"] and "<img src=x" not in p["html"] and "<b>Denver" not in p["html"]
    html = built[_path("Denver", "business")]["html"]
    assert "&lt;img src=x onerror=alert(1)&gt;Intern" in html and "Evil &amp; Co &quot;&lt;/title&gt;" in html


def test_no_em_or_en_dash_in_the_words_the_near_pages_write(tmp_path):
    built = _built(_denver_site(tmp_path, 12))
    for p in built.values():
        if p["kind"] == "near" or p["path"] == NEAR:
            text = _main(p["html"])
            text += re.search(r"<title>(.*?)</title>", p["html"]).group(1)
            text += re.search(r'<meta name="description" content="(.*?)"/>', p["html"]).group(1)
            assert "—" not in text and "–" not in text, p["path"]
