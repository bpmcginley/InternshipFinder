"""Leaf selection/render proof; no shared generator or provider is invoked."""

from datetime import datetime, timezone
from html import escape

import pytest

from internscout.site import advisor
from internscout.site.render.advisor import render
from test_seo_pages import _row


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
    assert page["thin"] and page["items"] == edition.items


def test_render_empty_unmapped_and_undated_never_invents_weekly_count():
    rows = lambda *_: pytest.fail("Empty edition must not invoke listing renderer")
    empty = render(advisor.select(data([]))[0], listing_rows=rows)
    assert (
        "0 open student roles" in empty["body"]
        and "Older open roles may still be available" in empty["body"]
    )
    undated = render(advisor.select(data([], stamp=None))[0], listing_rows=rows)
    assert "cannot be verified" in undated["body"] and "0 open" not in undated["body"]
    unmapped = render(
        advisor.select(data([], [{"name": "Undeclared", "tags": []}]))[0], listing_rows=rows
    )
    assert "no direct field mapping" in unmapped["body"] and "0 open" not in unmapped["body"]
