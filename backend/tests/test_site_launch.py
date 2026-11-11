"""The fixed pilot adds honest cohorts without changing existing page decisions."""

import re

import pytest

from internscout.site import launch, publish, runtime
from tests.seo_fixture_data import _row, _site

pytestmark = pytest.mark.without_seo_facade


def rows(n, **over):
    return [dict(_row(i, tags=("swe",), **over), keys={"MA"}) for i in range(n)]


def select(items, existing=(), live=(), earning=frozenset()):
    return launch.select(
        items,
        existing,
        live,
        earning,
        employers_in=lambda xs: runtime._build.employer_count(xs, runtime.employer_key),
        indexed=runtime.combo_indexed,
        near_same=runtime.near_same,
        fold_at=lambda path: runtime.SAME_SHARE if path in live else runtime.NEAR_SAME,
        places=runtime.PLACES,
    )


@pytest.mark.parametrize("count,indexed", [(9, None), (10, False), (19, False), (20, True)])
def test_fixed_minimum_and_existing_index_bar(count, indexed):
    made = select(rows(count))
    assert len(made) == (indexed is not None)
    if made:
        assert made[0].indexed == indexed


def test_live_and_earning_exceptions_never_lower_the_ten_role_floor():
    path = "/internships/summer-2027/software-engineering/"
    assert select(rows(18), live={path})[0].indexed
    assert not select(rows(17), live={path})[0].indexed
    assert select(rows(10), earning={path})[0].indexed
    assert not select(rows(9), live={path}, earning={path})


def test_duplicate_ids_employer_diversity_spread_and_path_collision():
    assert not select(rows(9) * 3)
    assert not select(rows(20, company_name="One company"))
    broad = rows(20)
    for row in broad:
        row["keys"] = set(list(runtime.PLACES)[:10])
    assert not select(broad)
    path = "/internships/summer-2027/software-engineering/"
    assert not select(rows(20), [{"path": path, "items": []}])


def test_existing_pages_win_and_pilot_near_duplicates_fold():
    items = rows(20)
    parent = {"path": "/internships/software-engineering/", "items": items + rows(4)}
    assert not select(items, [parent])
    for row in items:
        row["field_tags"].append("finance")
    made = select(items)
    assert len(made) == 1
    assert made[0].path == "/internships/summer-2027/finance/"
    assert [x.path for x in select(list(reversed(items)))] == [x.path for x in made]


def test_explicit_standing_excludes_generic_undergraduate_and_staff_titles():
    assert not launch.explicit_standing(
        {"title": "Undergraduate intern", "years": ["senior", "sophomore"]}, "senior"
    )
    assert not launch.explicit_standing({"title": "Senior analyst intern"}, "senior")
    assert launch.explicit_standing({"title": "Rising senior intern"}, "senior")
    assert launch.explicit_standing({"title": "Sophomore internship"}, "sophomore")
    assert launch.explicit_standing({"insights": {"class_standing": ["senior"]}}, "senior")


def test_metro_membership_is_required_and_first_year_is_never_added():
    items = rows(20, insights={"class_standing": ["sophomore", "freshman"]}, term=None)
    for row in items:
        row["keys"] = {"CO"}
    assert not select(items)
    for row in items:
        row["keys"].add("Denver")
    made = select(items)
    assert [x.path for x in made] == ["/internships/for-sophomores/denver/"]


@pytest.mark.parametrize("value", [7, True, "not senior", {"senior": True}, ["not senior"], None])
def test_malformed_standing_is_not_evidence(value):
    assert not launch.explicit_standing({"insights": {"class_standing": value}}, "senior")


def test_missing_parent_has_one_root_crumb_and_bounded_visible_count():
    from internscout.site import field
    from internscout.site.render.launch import render
    from datetime import datetime, timezone

    model = launch.Page(
        "/internships/for-seniors/chicago/", rows(41), None, "senior", "Chicago", True
    )
    context = field.Context(
        ("/internships/", "Internships"),
        datetime(2026, 11, 10, tzinfo=timezone.utc),
        "November 10, 2026",
    )
    page = render(
        model,
        context,
        field_title=runtime.field_title,
        field_slug=runtime.field_slug,
        state_slug=runtime.state_slug,
        metro_state=runtime.METRO_STATE,
        place_names=runtime.US_STATES,
        dash_link=runtime.dash_link,
        listing_rows=lambda *a, **k: "",
        autoapply_card=lambda *a: "",
        per_page=40,
        existing_paths=set(),
    )
    assert page["crumbs"].count(context.root) == 1
    assert "Showing 40 of 41 roles." in page["body"]
    assert "mention senior standing" in page["body"]
    assert 'href="/?state=IL&amp;year=senior"' in page["body"]


def test_fixed_cap_and_no_remote_aliases(monkeypatch):
    assert len(launch.PILOT) == 5 <= launch.MAX_PAGES == 60
    assert all("remote" not in slug and "fresh" not in slug for slug, *_ in launch.PILOT)
    monkeypatch.setattr(launch, "PILOT", launch.PILOT * 13)
    with pytest.raises(ValueError, match="cap"):
        select([])


def fixture_rows():
    result = []
    for field in ("swe", "data", "finance"):
        for i in range(50):
            result.append(
                _row(
                    len(result),
                    tags=(field,),
                    title=f"Test {field} internship {i}",
                    term="Summer 2027" if i < 24 else "Spring 2027",
                )
            )
    for year, city, state in (("senior", "Chicago", "IL"), ("sophomore", "Denver", "CO")):
        for i in range(60):
            result.append(
                _row(
                    len(result),
                    state=state,
                    title=f"Test student internship {i}",
                    term=None,
                    years=[year],
                    insights={"class_standing": [year]} if i < 22 else None,
                    regions=[{"loc": f"{city}, {state}", "state": state, "kind": "state"}],
                )
            )
    return result


def test_thin_pilot_keeps_canonical_and_feed_but_not_sitemap(tmp_path):
    from internscout import feeds, site_links

    items = [
        _row(i, tags=("swe",), term="Summer 2027" if i < 10 else "Spring 2027") for i in range(30)
    ]
    site = _site(tmp_path, {"MA": items})
    state = runtime.BuildState(near_on=False)
    hooks = runtime.BuildHooks()
    pages = runtime.invoke(state, hooks, runtime.build, site, earning=frozenset())
    path = "/internships/summer-2027/software-engineering/"
    page = next(p for p in pages if p["path"] == path)
    assert page["thin"] and not page["index"]
    assert '<meta name="robots" content="noindex, follow"' in page["html"]
    publish._write_site(site, pages, state, hooks)
    feeds.write_all(site, pages, state.generated)
    assert (tmp_path / path.strip("/") / "feed.xml").is_file()
    assert f"https://internscout.org{path}</loc>" not in (tmp_path / "sitemap.xml").read_text()
    # The minimal fixture has no handwritten assets; audit the new feed/canonical targets specifically.
    assert not [
        p
        for p in site_links.audit(site)["problems"]
        if p["source"] == path and (p["target"].endswith("feed.xml") or p["kind"] == "canonical")
    ]


def test_full_build_preserves_existing_pages_and_adds_five_bounded_cohorts(tmp_path, monkeypatch):
    items = fixture_rows()
    # Invalid and closed rows must not enter the count through a new selector.
    items += [
        _row(900, tags=("swe",), status="closed"),
        _row(901, tags=("swe",), apply_url="javascript:alert(1)"),
    ]
    site = _site(tmp_path, {"MA": items})
    pilot = launch.PILOT
    monkeypatch.setattr(launch, "PILOT", ())
    before = {p["path"]: p for p in runtime.build_snapshot(site, earning=frozenset()).pages}
    monkeypatch.setattr(launch, "PILOT", pilot)
    after = {p["path"]: p for p in runtime.build_snapshot(site, earning=frozenset()).pages}
    additions = {f"/internships/{slug}/" for slug, *_ in pilot}
    assert after.keys() - before.keys() == additions
    for path, old in before.items():
        assert after[path]["index"] == old["index"]
        assert after[path]["thin"] == old["thin"]
        assert [x["id"] for x in (after[path]["items"] or [])] == [
            x["id"] for x in (old["items"] or [])
        ]
        if path != "/internships/":
            assert after[path]["html"] == old["html"], path
    for path in additions:
        page = after[path]
        assert page["index"] and not page["thin"]
        assert len(page["items"]) in (22, 24)
        assert f'<link rel="canonical" href="https://internscout.org{path}"' in page["html"]
        assert 'href="feed.xml"' in page["html"]
        assert f'href="{path}"' in after["/internships/"]["html"]
    season = after["/internships/summer-2027/software-engineering/"]["html"]
    assert 'href="/?field=swe&amp;state=all"' in season
    assert "The dashboard includes other terms." in season
    standing = after["/internships/for-sophomores/denver/"]["html"]
    assert 'href="/?state=CO&amp;year=sophomore"' in standing
    assert "without stated class-year requirements" in standing
    assert 'class="jobs"' in standing and re.search(r'<main\b', standing)
