"""Employer landing page eligibility, aliases, metadata and rendering."""

import os

import pytest

from internscout import seo_pages
from tests.seo_fixture_data import _row, _site
from test_seo_pages import COMBO, _DASHES, _built, _head, _paths


def test_spellings_of_one_employer_share_a_page_and_a_role_counts_once(tmp_path):
    a = [_row(i, company_name="Boeing") for i in range(8)]
    b = [_row(20 + i, company_name="The Boeing Company") for i in range(4)]
    dup = [
        _row(40, company_name="The Boeing Company", title=a[0]["title"], regions=a[0]["regions"])
    ]  # second board
    site = _site(tmp_path, {"MA": a + b + dup})
    pages = {p["path"]: p for p in seo_pages.build(site)}
    assert "/internships/at/the-boeing-company/" not in pages
    boeing = pages["/internships/at/boeing/"]
    # was: "Boeing Internships – 12 Open Now". Since 2026-10-01 the title names the term most roles share,
    # and since 2026-10-07 before "Internships", as searches word it. was: "Boeing Internships (Summer 2027)".
    # 2026-10-13: the search's own words first, then a count floor. was: "Boeing Summer 2027 Internships – 12 Open".
    assert len(boeing["items"]) == 12
    assert (
        "<title>Boeing Internships Summer 2027: 10+ Open Roles | InternScout</title>"
        in boeing["html"]
    )
    assert "company=Boeing&amp;company=The%20Boeing%20Company" in boeing["html"]
    assert (
        '<a href="/internships/at/boeing/">The Boeing Company</a>'
        in pages["/internships/massachusetts/"]["html"]
    )
    assert seo_pages.employer_key("Magna International") == seo_pages.employer_key("Magna")
    assert seo_pages.employer_key("Booz Allen Hamilton") == seo_pages.employer_key("Booz Allen")
    assert seo_pages.employer_key("Bank of America") == "bank of america"


def test_a_work_study_board_gets_no_employer_page(tmp_path):
    rows = [
        _row(
            i,
            company_name="Some University",
            stage=["part_time"],
            title=f"Library Assistant (FWS) {i}",
        )
        for i in range(12)
    ]
    site = _site(tmp_path, {"MA": rows})
    assert "/internships/at/some-university/" not in _paths(seo_pages.build(site))


@pytest.mark.parametrize("short_count,long_count", [(12, 0), (0, 12), (6, 6), (8, 4), (4, 8)])
def test_altera_keeps_its_current_url_when_source_name_counts_flip(
    tmp_path, short_count, long_count
):
    rows = [_row(i, company_name="Altera") for i in range(short_count)]
    rows += [_row(20 + i, company_name="Altera Corporation") for i in range(long_count)]
    site = _site(tmp_path, {"MA": rows})
    pages = {p["path"]: p for p in seo_pages.build(site)}
    assert "/internships/at/altera-corporation/" not in pages
    assert len(pages["/internships/at/altera/"]["items"]) == 12
    assert set(seo_pages.EMPLOYERS.values()) == {"/internships/at/altera/"}
    assert 'href="/internships/at/altera/"' in pages["/internships/at/"]["html"]


@pytest.mark.parametrize("count", [6, 12])
def test_retired_altera_url_redirects_only_to_the_existing_current_page(tmp_path, count):
    site = _site(
        tmp_path, {"MA": [_row(i, company_name="Altera Corporation") for i in range(count)]}
    )
    pages = seo_pages.build(site)
    target = next(p for p in pages if p["path"] == "/internships/at/altera/")
    assert target["index"] is (count >= seo_pages.INDEX_EMPLOYER)
    seo_pages.write(site, pages)
    redirect = (tmp_path / "internships/at/altera-corporation/index.html").read_text(
        encoding="utf-8"
    )
    assert (
        '<meta http-equiv="refresh" content="0;url=https://internscout.org/internships/at/altera/">'
        in redirect
    )
    assert (
        '<link rel="canonical" href="https://internscout.org/internships/at/altera/">' in redirect
    )
    assert '<a href="/internships/at/altera/">Altera internships</a>' in redirect
    assert '<script' not in redirect
    assert '/internships/at/altera-corporation/' not in (tmp_path / 'sitemap.xml').read_text(
        encoding="utf-8"
    )
    assert '/internships/at/altera-corporation/' not in (tmp_path / seo_pages.HELD_FILE).read_text(
        encoding="utf-8"
    )
    assert '/internships/at/altera/' in _paths(pages)


def test_altera_redirect_is_not_created_when_existing_generation_rules_omit_the_target(tmp_path):
    site = _site(tmp_path, {"MA": [_row(i, company_name="Altera Corporation") for i in range(2)]})
    pages = seo_pages.build(site)
    assert '/internships/at/altera/' not in _paths(pages)
    seo_pages.write(site, pages)
    assert not (tmp_path / 'internships/at/altera-corporation/index.html').exists()


def test_employer_pages_answer_when_where_and_pay_from_their_own_roles(tmp_path):
    rows = [
        _row(
            i,
            company_name="Big Co",
            salary="$38.00",
            regions=[{"loc": "Denver, Colorado", "kind": "us", "state": "CO"}],
        )
        for i in range(8)
    ]
    rows += [
        _row(
            10 + i,
            company_name="Big Co",
            term="Winter 2027",
            salary="$22.50 - $31.50",
            regions=[{"loc": "Denver, CO", "kind": "us", "state": "CO"}],
        )
        for i in range(2)
    ]
    rows += [
        _row(20 + i, company_name="Big Co", salary="$90,000 a year") for i in range(2)
    ]  # yearly: not an hourly rate
    site = _site(tmp_path, {"MA": rows, "CO": []})
    h = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/at/big-co/")
    # was: "Big Co Summer 2027 Internships – 12 Open | InternScout" (2026-10-13)
    assert "<title>Big Co Internships Summer 2027: 10+ Open Roles | InternScout</title>" in h
    # 2026-10-07: what the employer's own careers page doesn't show in one place leads the description.
    desc = _head(h, r'<meta name="description" content="(.*?)"/>')
    # was: "12 open Big Co internships for Summer 2027 on one page, in Denver, CO" and "$22.50–$38/hour".
    assert desc.startswith(
        "12 open Big Co internships for Summer 2027 in Denver, CO, Town 20, MA and Town 21, MA."
    )
    assert "Listed pay $22.50-$38/hr." in desc
    assert "Newest posted " in desc and "Updated" not in desc and len(desc) <= seo_pages.DESC_AIM
    assert "<dt>Listed pay</dt><dd>$22.50 to $38 an hour, on 10 of 12 roles</dd>" in h
    facts = h.split('<dl class="facts">')[1].split("</dl>")[0]
    assert "Denver, CO (10)" in facts and "Colorado" not in facts  # one place, however it's spelled
    assert (
        "Summer 2027 is the most common start: 10 of the 12 open roles. Others start in Winter 2027."
        in h
    )
    assert (
        "<h2>Does Big Co pay interns?</h2><p>10 of the 12 open roles list pay, from $22.50 to $38 an hour.</p>"
        in h
    )


def test_employer_pages_say_so_when_postings_leave_things_out(tmp_path):
    rows = [_row(i, company_name="Quiet Co", term=None) for i in range(10)]
    rows[0]["term"] = "Summer 2027"
    site = _site(tmp_path, {"MA": rows})
    h = next(p["html"] for p in seo_pages.build(site) if p["path"] == "/internships/at/quiet-co/")
    assert (
        "<title>Quiet Co Internships: 10+ Open Roles | InternScout</title>" in h
    )  # no term most roles share
    assert "None of the 10 open postings lists pay." in h
    assert "Only 1 of the 10 open roles gives a start term: Summer 2027. The rest don’t say." in h


def test_an_employer_with_five_roles_gets_a_page(tmp_path):
    site = _site(
        tmp_path,
        {
            "MA": [_row(i, company_name="Five Co") for i in range(5)]
            + [_row(10 + i, company_name="Four Co") for i in range(4)]
        },
    )
    paths = _paths(seo_pages.build(site))
    assert "/internships/at/five-co/" in paths and "/internships/at/four-co/" not in paths


def test_employer_page_offers_auto_apply_with_its_own_tag(tmp_path):
    rows = [
        _row(
            i,
            company_name="Big Co",
            ats="workday",
            apply_url=f"https://bigco.wd1.myworkdayjobs.com/job/{i}",
        )
        for i in range(seo_pages.MIN_EMPLOYER)
    ]
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    own = pages["/internships/at/big-co/"]
    assert "utm_source=seo-employer" in own and "stops at Submit" in own
    assert "install.html?from=seo-employer-row" in own
    assert f"All {seo_pages.MIN_EMPLOYER} of these applications are on Workday" in own
    # The phone/tablet switch is CSS only, the same media query as install.html.
    assert (
        ".ext-touch{display:none}@media (pointer:coarse) and (hover:none){.ext-desk{display:none}"
        in own
    )
    assert '<a href="/install.html">Auto-Apply (free)</a>' in own
    assert "utm_source=seo-state" in pages["/internships/massachusetts/"]
    assert "utm_source=seo-hub" in pages["/internships/new/"]


def test_employer_titles_lead_with_the_search_phrase_for_every_count_and_term():
    title = seo_pages.employer_title
    assert (
        title("Under Armour", 10, "Summer 2027")
        == "Under Armour Internships Summer 2027: 10+ Open | InternScout"
    )
    assert (
        title("Lyft", 18, "Summer 2027")
        == "Lyft Internships Summer 2027: 15+ Open Roles | InternScout"
    )
    assert (
        title("Rivian", 41, "Spring 2027")
        == "Rivian Internships Spring 2027: 40+ Open Roles | InternScout"
    )
    assert (
        title("Gilead Sciences", 103, None)
        == "Gilead Sciences Internships: 100+ Open Roles | InternScout"
    )
    # Under 10 roles, no number: the exact one would change with every refresh.
    assert (
        title("Medtronic", 9, "Summer 2027")
        == "Medtronic Internships Summer 2027: Open Roles | InternScout"
    )
    assert title("Medtronic", 1, "Summer 2027") == title("Medtronic", 0, "Summer 2027")
    assert title("ADT", 7, None) == "ADT Internships: Open Roles | InternScout"
    assert (
        title("Campbell Soup Company", 6, "Summer 2027")
        == "Campbell Soup Company Internships Summer 2027 | InternScout"
    )
    # A long name keeps its term over the brand and the count, and is never cut mid-word.
    assert (
        title("Blue Cross Blue Shield of Michigan", 12, "Summer 2027")
        == "Blue Cross Blue Shield of Michigan Internships Summer 2027"
    )
    for name in (
        "X",
        "M&T Bank",
        "Blue Cross Blue Shield of Michigan",
        "A" * 80,
        "Executive Office for U.S. Attorneys",
    ):
        for n in (0, 1, 9, 10, 1000):
            for term in (None, "Summer 2027", "Fall 2026", "Winter 2027"):
                t = title(name, n, term)
                assert 0 < len(t) <= seo_pages.TITLE_MAX, t
                assert not any(d in t for d in _DASHES) and t.count(seo_pages.TITLE_SUFFIX) <= 1, t
                assert t.startswith(name[:20]), t


def test_employer_descriptions_count_right_and_fit_for_zero_one_and_many():
    from datetime import datetime

    desc = seo_pages.employer_description
    day = datetime(2026, 10, 13)
    many = desc(
        "Bose",
        12,
        None,
        ["Framingham, MA", "Atlanta, GA", "Bloomfield Hills, MI"],
        (22.0, 51.25, 9),
        day,
        co_ops=2,
    )
    assert many.startswith(
        "12 open Bose internships and co-ops in Framingham, MA, Atlanta, GA and Bloomfield Hills, MI."
    )
    assert "Listed pay $22-$51.25/hr." in many and "Newest posted Oct 13." in many
    one = desc("Acme", 1, "Summer 2027", ["Boston, MA"], None, day)
    assert (
        one.startswith("1 open Acme internship for Summer 2027 in Boston, MA.")
        and "internships" not in one
    )
    assert desc("Acme", 1, None, [], None, day, co_ops=1).startswith("1 open Acme co-op.")
    zero = desc("Acme", 0, "Summer 2027", [], None, None)
    assert zero.startswith("No Acme internships are open right now.") and "0 open" not in zero
    # Pay and the newest posting outrank a second and third place.
    places = ["Lake Saint Louis, MO", "Fort Lauderdale, FL", "Colorado Springs, CO"]
    d = desc(
        "National Information Solutions Cooperative (NISC)",
        10,
        "Summer 2027",
        places,
        (25.0, 25.0, 10),
        day,
    )
    assert (
        "Listed pay $25/hr." in d and "Newest posted Oct 13." in d and "Colorado Springs" not in d
    )
    assert "(NISC)'s" not in d  # too long a name for a possessive
    # "own posting" only when no role links to a job site instead.
    assert "Acme's own posting" in desc("Acme", 2, None, [], None, None)
    assert "own posting" not in desc("Acme", 2, None, [], None, None, own_links=False)
    assert seo_pages.own_posting({"apply_url": "https://acme.wd5.myworkdayjobs.com/x/job/1"})
    assert seo_pages.own_posting(
        {"apply_url": "https://www.tesla.com/careers/search/job/1?source=indeed"}
    )
    for url in (
        "https://ca.linkedin.com/jobs/view/1",
        "https://www.indeed.com/viewjob?jk=1",
        "https://simplify.jobs/p/1",
        "https://app.joinhandshake.com/public/jobs/1",
        "",
    ):
        assert not seo_pages.own_posting({"apply_url": url}), url
    for name in ("X", "Under Armour", "Blue Cross Blue Shield of Michigan", "A" * 120):
        for n in (0, 1, 5, 2446):
            for pay in (None, (18.0, 28.0, 3)):
                text = seo_pages.fit_description(
                    desc(name, n, "Summer 2027", ["Baltimore, MD", "Austin, TX"], pay, day)
                )
                assert seo_pages.DESC_MIN <= len(text) <= seo_pages.DESC_MAX, text
                assert not any(dash in text for dash in _DASHES), text


EMPLOYER = "/internships/at/small-co/"


def _employer_site(tmp_path, n):
    """n roles at Small Co in Massachusetts, among others at their own employers."""
    rows = [_row(i, company_name="Small Co") for i in range(n)] + [_row(100 + i) for i in range(20)]
    return _site(tmp_path, {"MA": rows})


def test_employer_indexed_threshold_slack_and_search_traffic():
    need, slack = seo_pages.INDEX_EMPLOYER, seo_pages.INDEX_SLACK
    ok = seo_pages.employer_indexed
    assert need == 10 and seo_pages.MIN_EMPLOYER < need
    assert ok(need, EMPLOYER, set()) and not ok(need - 1, EMPLOYER, set())
    assert ok(
        seo_pages.MIN_EMPLOYER, EMPLOYER, set(), frozenset({EMPLOYER})
    )  # people find it in search
    assert ok(need - slack, EMPLOYER, {EMPLOYER}) and not ok(need - slack - 1, EMPLOYER, {EMPLOYER})


def test_an_employer_page_under_the_bar_is_built_and_linked_but_noindex(tmp_path):
    site = _employer_site(tmp_path, seo_pages.INDEX_EMPLOYER - 1)
    built = _built(site)
    page = built[EMPLOYER]
    assert page["thin"] and not page["index"]
    assert '<meta name="robots" content="noindex, follow"/>' in page["html"]
    assert f'<link rel="canonical" href="https://internscout.org{EMPLOYER}"/>' in page["html"]
    seo_pages.write(site, list(built.values()))
    sitemap = open(os.path.join(site, "sitemap.xml"), encoding="utf-8").read()
    assert f"<loc>https://internscout.org{EMPLOYER}</loc>" not in sitemap
    listing = os.path.join(site, seo_pages.HELD_FILE)
    assert EMPLOYER in seo_pages.held_paths(listing)
    lines = open(listing, encoding="utf-8").read().splitlines()
    assert lines[0].startswith("# ") and all(s.startswith("/internships/") for s in lines[1:])
    big = _built(_employer_site(tmp_path / "big", seo_pages.INDEX_EMPLOYER))[EMPLOYER]
    assert big["index"] and not big["thin"] and "noindex" not in big["html"]
    assert _built(site, earning=frozenset({EMPLOYER}))[EMPLOYER]["index"]


def test_the_employer_slack_holds_even_when_the_noindex_list_could_not_be_fetched(tmp_path):
    # pages.yml deletes live-noindex.txt when its fetch fails, so build() gets no held pages. was
    # (2026-10-23): the slack then switched off and dropped the page below for good.
    site = _employer_site(tmp_path, seo_pages.INDEX_EMPLOYER - 1)
    assert _built(site, live={EMPLOYER})[EMPLOYER]["index"]
    assert _built(site, live={EMPLOYER}, held={COMBO})[EMPLOYER]["index"]


def test_index_employer_at_min_employer_indexes_every_employer_page_again(tmp_path, monkeypatch):
    monkeypatch.setattr(
        seo_pages, "INDEX_EMPLOYER", seo_pages.MIN_EMPLOYER
    )  # the one-constant revert
    assert _built(_employer_site(tmp_path, seo_pages.MIN_EMPLOYER))[EMPLOYER]["index"]
