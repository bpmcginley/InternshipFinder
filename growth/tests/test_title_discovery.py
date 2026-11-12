"""Draft title sheets must remain traceable, fresh and useful without publishing anything."""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "growth"))
import title_discovery as td  # noqa: E402
from tests.seo_fixture_data import _row, _site  # noqa: E402

pytestmark = pytest.mark.without_seo_facade

NOW = datetime(2026, 11, 2, 20, tzinfo=timezone.utc)


def rows():
    return [
        dict(
            _row(
                fi * 100 + i,
                tags=(field,),
                title=f"{field.title()} Planning Intern {i}",
                company_name=f"Employer {i}",
                first_seen=(NOW - timedelta(hours=i)).isoformat(),
                last_seen=NOW.isoformat(),
            ),
            keys=["MA"],
        )
        for fi, field in enumerate(("finance", "marketing", "operations"))
        for i in range(td.MIN_ROLES)
    ]


def data(items=None):
    return {"generated_at": NOW.isoformat(), "listings": items if items is not None else rows()}


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://jobs.example.com/1",
        "https://localhost/1",
        "https://127.0.0.1/job",
        "https://192.168.1.1/job",
        "https://10.1.0.1/job",
        "https://user:password@jobs.example.com/job",
        "https://jobs.example.com:8443/1",
        "https://jobs.local/job",
        "https://jobs.example.com/a\nb",
        "https://jobs.example.com\\@localhost/1",
        "https://jobs.example.com/?access_token=secret",
        "https://jobs.example.com:broken/1",
        "https://2130706433/1",
        None,
        42,
        "https://jooble.org/jdp/1",
        "https://www.indeed.com/viewjob?jk=123",
    ],
)
def test_source_links_reject_nonpublic_or_credential_urls(url):
    assert td.source_url(url) is None


def test_source_links_keep_public_requisition_query_but_dedupe_tracking():
    url = "https://jobs.example.com/open?jobId=3&utm_source=feed#details"
    assert td.source_url(url) == url
    assert td.url_key(url) == td.url_key("https://jobs.example.com:443/open/?jobId=3&fbclid=abc")
    assert td.url_key(url) != td.url_key("https://jobs.example.com/open?jobId=4")


@pytest.mark.parametrize(
    "stamp",
    [
        None,
        "bad",
        (NOW - td.MAX_AGE - timedelta(seconds=1)).isoformat(),
        (NOW + timedelta(minutes=6)).isoformat(),
    ],
)
def test_missing_stale_or_future_export_refuses_the_entire_pack(stamp):
    source = data()
    source["generated_at"] = stamp
    with pytest.raises(ValueError, match="export timestamp"):
        td.make_pack(source, NOW)


def test_selection_is_deterministic_diverse_and_has_exact_source_evidence():
    source = data()
    pack = td.make_pack(source, NOW)
    assert pack == td.make_pack(data(list(reversed(source["listings"]))), NOW)
    assert [sheet["field"] for sheet in pack["sheets"]] == ["finance", "marketing", "operations"]
    assert not pack["published"]
    assert "not degree eligibility" in pack["eligibility_note"]
    originals = {str(row["id"]): row for row in source["listings"]}
    for sheet in pack["sheets"]:
        assert len(sheet["roles"]) == len({r["employer"] for r in sheet["roles"]}) == 4
        assert len({r["title"] for r in sheet["roles"]}) == 4
        assert (
            sheet["eligible_distinct_title_employer_pairs"]
            == len(sheet["eligible_role_ids"])
            == td.MIN_ROLES
        )
        query = parse_qs(urlsplit(sheet["dashboard_url"]).query)
        assert query == {"field": [sheet["field"]], "state": [",".join(td.STATES)]}
        for role in sheet["roles"]:
            original = originals[role["id"]]
            assert role["source_url"] == original["apply_url"]
            assert role["source_title"] == role["title"] == original["title"]
            assert role["source_company_name"] == original["company_name"]
            assert sheet["field"] in original["field_tags"]
            assert role["title"] in sheet["caption"]
        assert "Link in bio" not in sheet["caption"]
        for channel, caption in sheet["captions_by_channel"].items():
            link = caption.split("Search the field: ", 1)[1].splitlines()[0]
            tags = parse_qs(urlsplit(link).query)
            assert tags["state"] == [",".join(td.STATES)]
            assert tags["utm_source"] == [channel]
            assert tags["utm_medium"] == ["social"]
            assert tags["utm_campaign"] == ["title-discovery-2026w45"]
            assert tags["utm_content"] == [f"titles_{sheet['field']}"]


def test_duplicate_ids_urls_and_employer_titles_do_not_inflate_supply():
    original = rows()
    first = original[0]
    copies = [
        dict(first),
        dict(first, id="duplicate-url", title="Another Intern"),
        dict(first, id="duplicate-title", apply_url="https://jobs.example.com/another"),
        dict(first, id="tracking-copy", apply_url=first["apply_url"] + "?utm_source=one"),
    ]
    pack = td.make_pack(data(copies + original), NOW)
    sheet = pack["sheets"][0]
    assert sheet["eligible_distinct_title_employer_pairs"] == td.MIN_ROLES
    assert len({r["source_url"] for r in sheet["roles"]}) == 4


@pytest.mark.parametrize(
    "change",
    [
        {"last_seen": None},
        {"last_seen": (NOW - timedelta(hours=49)).isoformat()},
        {"last_seen": (NOW + timedelta(minutes=6)).isoformat()},
        {"status": "closed"},
        {"apply_url": "https://127.0.0.1/job"},
        {"keys": {"CA"}},
        {"stage": ["full_time"]},
        {"field_tags": ["swe"]},
        {"title": "Finance Internship (PharmD)"},
        {"title": "Finance Internship Ph.D."},
        {"title": "Doctoral Finance Intern"},
        {"title": "Finance Internship MBA"},
    ],
)
def test_ineligible_rows_cannot_make_a_thin_field_pass_the_threshold(change):
    items = rows()
    items[0].update(change)
    with pytest.raises(ValueError, match="need three fields"):
        td.make_pack(data(items), NOW)


def test_expiry_uses_the_oldest_selected_source_observation():
    items = rows()
    items[0]["last_seen"] = (NOW - timedelta(hours=20)).isoformat()
    pack = td.make_pack(data(items), NOW)
    assert datetime.fromisoformat(pack["expires_at"]) == NOW + timedelta(hours=28)


def test_energy_market_title_is_not_a_marketing_example_but_stays_in_tagged_supply():
    energy = dict(
        _row(
            9999,
            tags=("marketing",),
            title="Intern - Energy Market Research & Engineering",
            company_name="New York ISO",
            first_seen=NOW.isoformat(),
            last_seen=NOW.isoformat(),
        ),
        keys=["MA"],
    )
    pack = td.make_pack(data([energy] + rows()), NOW)
    marketing = next(sheet for sheet in pack["sheets"] if sheet["field"] == "marketing")
    assert marketing["eligible_distinct_title_employer_pairs"] == td.MIN_ROLES + 1
    assert energy["id"] in marketing["eligible_role_ids"]
    assert energy["id"] not in {role["id"] for role in marketing["roles"]}
    assert energy["title"] not in marketing["caption"]


def test_build_writes_three_readable_images_and_evidence_without_overwriting(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    site = _site(tmp_path / "site", {"MA": rows()})
    index_path = Path(site) / "data/listings/index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["generated_at"] = NOW.isoformat()
    index_path.write_text(json.dumps(index), encoding="utf-8")
    out = tmp_path / "pack"
    pack = td.build(site, str(out), NOW)
    assert json.loads((out / "pack.json").read_text(encoding="utf-8")) == pack
    assert len(list(out.glob("*.png"))) == 3
    for sheet in pack["sheets"]:
        with Image.open(out / sheet["image"]) as image:
            assert image.size == (1080, 1350)
    assert "Nothing has been posted" in (out / "REVIEW.txt").read_text(encoding="utf-8")
    saved = (out / "pack.json").read_bytes()
    with pytest.raises(ValueError, match="must be empty"):
        td.build(site, str(out), NOW)
    assert (out / "pack.json").read_bytes() == saved


def test_stale_build_writes_no_output(tmp_path):
    site = _site(tmp_path / "site", {"MA": rows()})
    out = tmp_path / "pack"
    with pytest.raises(ValueError, match="export timestamp"):
        td.build(site, str(out), NOW)
    assert not out.exists()
