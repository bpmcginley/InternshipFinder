"""Kind pages and summer tracker selection and rendering."""

import re
import xml.etree.ElementTree as ET

from internscout import seo_pages
from test_seo_pages import _row, _site, _tracker_site


def test_term_pay_stage_and_class_year_pages_list_only_what_their_title_says(tmp_path):
    rows = (
        [_row(i, salary="$25/hr") for i in range(30)]  # Summer 2027, paid
        + [_row(100 + i, term="Spring 2027", stage=["co_op"]) for i in range(26)]  # co-ops
        + [_row(200 + i, term=None, years=["first_year", "sophomore"]) for i in range(26)]
        + [_row(300 + i, term="Fall 2027", stage=["research"]) for i in range(24)]
    )  # below MIN_KIND
    pages = {p["path"]: p for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    for path in (
        "/internships/summer-2027/",
        "/internships/spring-2027/",
        "/internships/paid/",
        "/internships/co-op/",
        "/internships/for-freshmen/",
        "/internships/for-sophomores/",
    ):
        assert path in pages, path
    assert "/internships/fall-2027/" not in pages and "/internships/research/" not in pages
    assert len(pages["/internships/summer-2027/"]["items"]) == 30
    assert all(x["stage"] == ["co_op"] for x in pages["/internships/co-op/"]["items"])
    assert len(pages["/internships/for-freshmen/"]["items"]) == 26  # only postings that say so
    # was: "Summer 2027 Internships – 30 Open Now | InternScout" (2026-10-13: a count floor, no dash)
    assert (
        "<title>Summer 2027 Internships: 30+ Open Now | InternScout</title>"
        in pages["/internships/summer-2027/"]["html"]
    )
    # The co-op page's opening doesn't claim "from internships to co-ops and research".
    assert "26 open student roles that are co-ops." in pages["/internships/co-op/"]["html"]
    # Each opens the dashboard on the matching filter, and the hub links every one.
    assert 'href="/?state=all&amp;stage=co_op"' in pages["/internships/co-op/"]["html"]
    assert 'href="/?state=all&amp;year=first_year"' in pages["/internships/for-freshmen/"]["html"]
    assert 'href="/?state=all&amp;paid=1"' in pages["/internships/paid/"]["html"]
    assert all(
        f'href="{p}"' in pages["/internships/"]["html"]
        for p in ("/internships/summer-2027/", "/internships/paid/", "/internships/for-sophomores/")
    )


def test_kind_descriptions_keep_eligibility_and_use_only_their_actual_employers():
    # 2026-10-23: shortening metadata must retain paid/eligibility qualifications from the postings.
    # Revert: remove this test when reverting kind_description.
    rows = [
        _row(i, company_name="Apollo", years=["first_year", "sophomore"], salary="$25/hr")
        for i in range(30)
    ]
    kinds = {k["slug"]: k for k in seo_pages.kinds(rows)}
    term = seo_pages.fit_description(
        seo_pages.kind_description(kinds["summer-2027"], rows, "October 23, 2026")
    )
    assert term.startswith("30 open Summer 2027 student roles.")
    assert "Hiring now: Apollo." in term and "most for Summer 2027" not in term
    for slug, qualifier in (
        ("paid", "list pay or say they are paid"),
        ("for-freshmen", "postings accept first-year college students"),
        ("for-sophomores", "postings accept sophomores"),
    ):
        desc = seo_pages.fit_description(
            seo_pages.kind_description(kinds[slug], rows, "October 23, 2026")
        )
        assert qualifier in desc
        assert "Apollo" in desc and "Beacon" not in desc
        assert len(desc) <= 155


def test_upcoming_summers_are_the_ones_still_ahead():
    from datetime import datetime, timezone

    terms = ["Summer 2026", "Summer 2027", "Summer 2028", "Fall 2026", None]
    assert seo_pages.upcoming_summers(terms, datetime(2026, 10, 7, tzinfo=timezone.utc)) == [
        "Summer 2027",
        "Summer 2028",
    ]
    assert (
        seo_pages.upcoming_summers(terms, datetime(2027, 3, 1, tzinfo=timezone.utc))[0]
        == "Summer 2027"
    )
    assert seo_pages.upcoming_summers(terms, datetime(2027, 6, 1, tzinfo=timezone.utc)) == [
        "Summer 2028"
    ]


def test_the_summer_tracker_lists_employers_newest_opened_first(tmp_path):
    pages = {p["path"]: p for p in seo_pages.build(_tracker_site(tmp_path))}
    path = "/internships/summer-2027/open/"
    assert path in pages and pages[path]["lastmod"] == "2026-09-22"
    html = pages[path]["html"]
    tracker = ET.fromstring(re.search(r'<table class="data tracker".*?</table>', html, re.S)[0])
    rows = [
        tuple(
            "".join(
                (cell.find("span[@class='cell-value']") if cell.tag == "td" else cell).itertext()
            )
            for cell in row
        )
        for row in tracker.findall("./tbody/tr")
    ]
    assert rows == [
        ("Alpha", "Sep 22, 2026", "6"),
        ("Delta", "Sep 21, 2026", "5"),
        ("Gamma", "By Sep 18, 2026", "5"),
        ("Epsilon", "Sep 15, 2026", "5"),
        ("Beta", "Aug 1, 2026", "5"),
    ]
    assert '<a href="/internships/at/alpha/">Alpha</a>' in html  # each employer links its page
    assert "As of September 23, 2026, 5 employers have opened Summer 2027 internships" in html
    assert "2 opened this week" in html  # Alpha and Delta; Epsilon is 8 days
    assert "not every employer" in html and "public job boards" in html
    assert "application/rss+xml" not in html  # no feed of its own
    # Linked from its term page, the new-this-week page, the hub, the employer index and every footer.
    for p in (
        "/internships/summer-2027/",
        "/internships/new/",
        "/internships/",
        "/internships/at/",
        "/internships/massachusetts/",
    ):
        assert f'href="{path}"' in pages[p]["html"], p
    assert '<a href="/internships/summer-2027/">Summer 2027</a>' in html  # its breadcrumb


def test_no_tracker_for_a_summer_that_has_passed(tmp_path):
    rows = [_row(i, term="Summer 2026") for i in range(30)]
    pages = {p["path"]: p["html"] for p in seo_pages.build(_site(tmp_path, {"MA": rows}))}
    assert "/internships/summer-2026/" in pages
    assert not any(p.endswith("/open/") for p in pages)
    assert "/open/" not in pages["/internships/massachusetts/"]
