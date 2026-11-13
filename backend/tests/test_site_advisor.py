"""Leaf selection/render proof; no shared generator or provider is invoked."""

from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path

import pytest

from internscout import page_dates
from internscout.site import advisor, publish, runtime
from internscout.site.render.advisor import render
from tests.seo_fixture_data import _row, _site

pytestmark = pytest.mark.without_seo_facade


END = "2026-11-11T12:00:00Z"


def row(i, **over):
    return dict(
        _row(
            i,
            tags=("swe",),
            first_seen="2026-11-10T12:00:00Z",
            posted_at="2026-11-10T10:00:00Z",
            **over,
        ),
        keys={"MA"},
    )


def data(rows, majors=None, stamp=END):
    return {
        "generated_at": stamp,
        "listings": rows,
        "baseline": "2026-09-01",
        "majors": majors
        if majors is not None
        else [{"name": "Computer Science", "tags": ["swe"], "related": ["data"]}],
    }


@pytest.mark.parametrize(
    "seen,posted,expected",
    [
        ("2026-11-04T12:00:00Z", None, False),
        ("2026-11-04T12:00:00.001Z", None, True),
        (END, None, True),
        ("2026-11-11T12:00:00.001Z", None, False),
        ("2026-11-11T07:00:00-05:00", None, True),
        ("2026-11-11T12:00:00", None, True),
        (None, None, False),
        ("invalid", None, False),
        ("2026-11-10T12:00:00Z", "2026-11-11T12:00:01Z", False),
        ("2026-11-10T12:00:00Z", "2026-10-28T12:00:00Z", False),
        ("2026-11-10T12:00:00Z", "2026-10-28T12:00:00.001Z", True),
        ("2026-11-10T12:00:00Z", "invalid", False),
    ],
)
def test_full_seven_day_window_and_no_future_or_old_postings(seen, posted, expected):
    item = dict(row(1), first_seen=seen, posted_at=posted)
    assert bool(advisor.select(data([item]))[0].items) == expected


def test_baseline_and_canada_bootstrap_are_not_new():
    item = row(1)
    value = data([item])
    value["baseline"] = "2026-11-10"
    assert not advisor.select(value)[0].items
    item.update(
        first_seen="2026-09-30T12:00:00Z",
        posted_at="2026-09-30T12:00:00Z",
        regions=[{"kind": "canada", "loc": "Toronto, ON"}],
    )
    assert not advisor.select(data([item], stamp="2026-10-01T12:00:00Z"))[0].items


def test_direct_union_ids_and_employer_title_location_dedupe():
    one = row(1, company_name="Example Labs")
    two = dict(one, id="duplicate-posting", field_tags=["data", "swe"])
    other = dict(row(2), field_tags=["data"])
    related = dict(row(3), field_tags=["finance"])
    majors = [{"name": "Combined", "tags": ["swe", "data"], "related": ["finance"]}]
    selected = advisor.select(data([one, one, two, other, related], majors))[0]
    assert len(selected.items) == 2
    assert "id3" not in {x["id"] for x in selected.items}
    assert selected.items == advisor.select(data([related, other, two, one], majors))[0].items


@pytest.mark.parametrize(
    "change",
    [
        {"status": "closed"},
        {"apply_url": "javascript:alert(1)"},
        {"apply_url": "https://"},
        {"apply_url": "https://a.example/has space"},
        {"apply_url": "https://user@a.example/"},
        {"title": 3},
        {"field_tags": "swe"},
    ],
)
def test_only_available_well_formed_safe_public_roles(change):
    assert not advisor.select(data([dict(row(1), **change)]))[0].items


@pytest.mark.parametrize(
    "url",
    [
        "https://:password@jobs.example/",
        "https://@jobs.example/",
        "https://user:@jobs.example/",
        "https://jobs.example/\x00role",
        "https://jobs.example/\x1frole",
        "https://jobs.example/\x7frole",
        "https://jobs.example/\x80role",
        "https://jobs.example/\\role",
        "https://jobs.example\\@other.example/",
        "https://jobs.example:bad/",
        "https://jobs.example:65536/",
        "https://jobs.example:-1/",
        "https://jobs.example:/",
    ],
)
def test_posting_rejects_all_userinfo_controls_backslashes_and_malformed_ports(url):
    assert not advisor.select(data([dict(row(1), apply_url=url)]))[0].items


@pytest.mark.parametrize(
    "url",
    [
        "https://jobs.example:443/role?team=engineering#details",
        "http://jobs.example:8080/role",
        "https://[2001:db8::1]:443/role",
        "https://jobs.example/role",
    ],
)
def test_ordinary_http_postings_and_valid_ports_remain_available(url):
    assert len(advisor.select(data([dict(row(1), apply_url=url)]))[0].items) == 1


def test_undergraduate_empty_unmapped_and_missing_date_are_distinct():
    majors = [
        {"name": "Empty", "tags": ["finance"]},
        {"name": "Unmapped", "tags": []},
        {"name": "Unknown", "tags": ["fake-field"]},
        {"name": "Malformed", "tags": "swe"},
        {"name": "Graduate", "tags": ["swe"], "level": "grad"},
    ]
    editions = {p.name: p for p in advisor.select(data([row(1)], majors))}
    assert set(editions) == {"Empty", "Unmapped", "Unknown", "Malformed"}
    assert editions["Empty"].state == "ready" and not editions["Empty"].items
    assert all(editions[n].state == "unmapped" for n in ("Unmapped", "Unknown", "Malformed"))
    for stamp in (None, "", "bad", {}, 20261111):
        edition = advisor.select(data([row(1)], stamp=stamp))[0]
        assert edition.state == "undated" and edition.stamp is None and not edition.items


def test_parent_uses_actual_canonical_map_not_assumed_major_path():
    edition = advisor.select(
        data([row(1)]), {"Computer Science": "/internships/software-engineering/"}
    )[0]
    assert edition.parent == "/internships/software-engineering/"
    for unsafe in (
        "https://example.test/",
        "/internships/../oops/",
        "/internships/for/?secret=1",
        None,
    ):
        assert (
            advisor.select(data([]), {"Computer Science": unsafe})[0].parent == "/internships/for/"
        )


def test_render_full_count_bounded_rows_and_escaped_copy_without_form():
    edition = advisor.select(
        data([row(i) for i in range(52)], [{"name": '<Bad & "Name">', "tags": ["swe"]}])
    )[0]
    calls = []

    def rows(items, stamp):
        calls.append((len(items), stamp))
        return ''.join(f'<li>{escape(x["title"])}</li>' for x in items)

    page = render(edition, listing_rows=rows)
    assert calls == [(40, datetime(2026, 11, 11, 12, tzinfo=timezone.utc))]
    assert "52 open student roles" in page["body"] and "Showing 40 of 52" in page["body"]
    assert '<Bad' not in page["body"] and '&lt;Bad &amp;' in page["body"]
    assert '<form' not in page["body"] and 'subscribe' not in page["body"]
    assert (
        "InternScout groups these roles by the major's fields. Check each posting for eligibility and current availability."
        in page["body"]
    )
    assert page["thin"] and page["dated"] == edition.items and "items" not in page


def test_render_empty_unmapped_and_undated_never_invents_weekly_count():
    rows = lambda *_: pytest.fail("Empty edition must not invoke listing renderer")
    empty = render(advisor.select(data([]))[0], listing_rows=rows)
    assert (
        "0 open student roles" in empty["body"]
        and "Older open roles may still be available" in empty["body"]
    )
    assert empty["body"].count("0 open student roles") == 1
    assert "No matching new roles" not in empty["body"]
    undated = render(advisor.select(data([], stamp=None))[0], listing_rows=rows)
    assert "cannot be verified" in undated["body"] and "0 open" not in undated["body"]
    unmapped = render(
        advisor.select(data([], [{"name": "Undeclared", "tags": []}]))[0], listing_rows=rows
    )
    assert "no direct field mapping" in unmapped["body"] and "0 open" not in unmapped["body"]


def set_export_stamp(site, value):
    path = Path(site) / "data/listings/index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    index["generated_at"] = value
    path.write_text(json.dumps(index), encoding="utf-8")


def build(site):
    state = runtime.BuildState(near_on=False)
    hooks = runtime.BuildHooks()
    pages = runtime.invoke(state, hooks, runtime.build, str(site), earning=frozenset())
    return {p["path"]: p for p in pages}, state, hooks


def exported(i):
    return {k: v for k, v in row(i).items() if k != "keys"}


def test_integrated_pages_preserve_existing_catalog_and_have_no_feeds(tmp_path, monkeypatch):
    majors = [
        {"name": "Computer Science", "tags": ["swe"]},
        {"name": "Same Fields", "tags": ["swe"]},
        {"name": "Empty", "tags": ["finance"]},
        {"name": "Undeclared", "tags": []},
    ]
    site = _site(tmp_path, {"MA": [exported(i) for i in range(52)]}, majors)
    set_export_stamp(site, END)
    select = advisor.select
    monkeypatch.setattr(advisor, "select", lambda *_: [])
    before, _, _ = build(site)
    monkeypatch.setattr(advisor, "select", select)
    after, state, hooks = build(site)
    additions = {p.path for p in select(data([], majors))}
    assert after.keys() - before.keys() == additions
    for path, page in before.items():
        assert after[path]["items"] == page["items"]
        assert after[path]["index"] == page["index"]
        if path != "/internships/for/":
            assert after[path]["html"] == page["html"], path
    publish._write_site(site, list(after.values()), state, hooks)
    sitemap = (Path(site) / "sitemap.xml").read_text(encoding="utf-8")
    hub = after["/internships/for/"]["html"]
    for path in additions:
        page = after[path]
        assert not page["index"] and page["thin"] and page["items"] is None
        assert f'href="{path}"' in hub
        assert f'<link rel="canonical" href="https://internscout.org{path}"' in page["html"]
        assert 'content="noindex, follow"' in page["html"]
        assert 'href="feed.xml"' not in page["html"]
        assert not (Path(site) / path.strip("/") / "feed.xml").exists()
        assert f'https://internscout.org{path}</loc>' not in sitemap
    weekly = after["/internships/for/computer-science-majors/weekly/"]["html"]
    assert 'href="/internships/software-engineering/"' in weekly
    assert "52 open student roles" in weekly and "Showing 40 of 52" in weekly


def test_selected_data_directory_supplies_weekly_roles_mapping_and_date(tmp_path, monkeypatch):
    served = _site(tmp_path / "served", {"MA": []}, [{"name": "Old Major", "tags": ["finance"]}])
    staged = _site(
        tmp_path / "staged", {"MA": [exported(1)]}, [{"name": "Computer Science", "tags": ["swe"]}]
    )
    set_export_stamp(staged, END)
    monkeypatch.setenv("INTERNSCOUT_PUBLIC_DATA", str(Path(staged) / "data"))
    pages, _, _ = build(served)
    assert "/internships/for/old-major-majors/weekly/" not in pages
    page = pages["/internships/for/computer-science-majors/weekly/"]
    assert "1 open student role first seen" in page["html"]
    assert "November 11, 2026 at 12:00 UTC" in page["html"]


def test_weekly_timestamp_rollover_is_routine_but_facts_and_source_citations_are_not():
    path = "/internships/for/computer-science-majors/weekly/"
    first = datetime(2026, 11, 11, 12, tzinfo=timezone.utc)
    second = datetime(2026, 11, 12, 13, tzinfo=timezone.utc)
    sentence = (
        "4 open student roles first seen in the seven days ending November 11, 2026 at 12:00 UTC."
    )
    html = f'<head><meta name="description" content="{sentence}"></head><body><p class="lede">{sentence}</p><p>Source November 11, 2026.</p></body>'
    later = html.replace("November 11, 2026 at 12:00 UTC", "November 12, 2026 at 13:00 UTC")
    digest = page_dates.fingerprint(path, html, first)
    assert digest == page_dates.fingerprint(path, later, second)
    assert digest != page_dates.fingerprint(path, later.replace("4 open", "3 open"), second)
    assert digest != page_dates.fingerprint(
        path, later.replace("Source November 11", "Source November 12"), second
    )
    citation = html.replace('class="lede"', 'class="source"')
    assert page_dates.fingerprint(path, citation, first) != page_dates.fingerprint(
        path, citation.replace("November 11", "November 12"), second
    )
    assert page_dates.fingerprint("/about/", html, first) != page_dates.fingerprint(
        "/about/", later, second
    )
