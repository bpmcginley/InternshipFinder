"""Qualify a posted direct link using the existing Taleo scan and detail response."""

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from internscout import pipeline
from internscout.db import Base
from internscout.dedupe import same_job
from internscout.discover import ats_of
from internscout.export_static import _listing_dict, closed_by_scan, shard_row
from internscout.models import Listing
from internscout.normalize import normalize
from internscout.scan_evidence import url_board
from internscout.sources.taleo import _direct_apply_url, fetch_taleo_board

DETAIL = "https://acme.taleo.net/careersection/123/jobdetail.ftl?job=MA-42"
DIRECT = "https://acme.taleo.net/careersection/123/jobapply.ftl?lang=en&job=MA-42"
APPLY_LINK = '<a href="jobapply.ftl?lang=en&amp;job=MA-42">Apply Online</a>'


@pytest.mark.parametrize(
    "relative",
    [
        "jobapply.ftl?job=MA-42&amp;lang=en",
        "/careersection/123/jobapply.ftl?lang=en&amp;job=MA-42",
        "https://acme.taleo.net/careersection/123/jobapply.ftl?lang=en&amp;job=MA-42",
    ],
)
def test_only_a_taleo_link_for_the_exact_posting_is_reused(relative):
    assert _direct_apply_url(f'<a href="{relative}">Apply Online</a>', DETAIL) == DIRECT


@pytest.mark.parametrize(
    "html",
    [
        APPLY_LINK.replace("MA-42", "MA-43"),
        APPLY_LINK.replace('href="', 'href="/careersection/124/'),
        APPLY_LINK.replace('href="', 'href="https://other.taleo.net/careersection/123/'),
        APPLY_LINK.replace('href="', 'href="https:///careersection/123/'),
        APPLY_LINK.replace('MA-42"', 'MA-42&amp;job=MA-43"'),
        APPLY_LINK.replace('MA-42"', 'MA-42&amp;returnUrl=https://example.test"'),
        APPLY_LINK.replace("lang=en", "lang="),
        APPLY_LINK.replace("<a ", '<a aria-disabled="true" '),
        APPLY_LINK.replace("<a ", '<a onclick="return false" '),
        APPLY_LINK.replace("<a ", "<a inert "),
        APPLY_LINK.replace("<a ", '<a href="/wrong" '),
        APPLY_LINK.replace("Apply Online", "Preview"),
        APPLY_LINK.replace("<a ", '<a aria-label="Preview" '),
        APPLY_LINK + APPLY_LINK.replace("lang=en", "lang=fr"),
        "<!-- " + APPLY_LINK + " -->",
        '<base href="https://other.taleo.net/">' + APPLY_LINK,
    ],
)
def test_ambiguous_or_unavailable_direct_links_fall_back(html):
    assert _direct_apply_url(html, DETAIL) is None


@pytest.mark.parametrize(
    ("opening", "closing"),
    [
        ("<div hidden><div>", "</div></div>"),
        ("<fieldset disabled>", "</fieldset>"),
        ("<div aria-hidden='true'>", "</div>"),
        ("<div inert>", "</div>"),
        ("<div style='display: /* hide */ none !important;'>", "</div>"),
        ("<div style='color: red; visibility: hidden'>", "</div>"),
        ("<details>", "</details>"),
        ("<template>", "</template>"),
        ("<noscript>", "</noscript>"),
        ("<textarea>", "</textarea>"),
        ("<title>", "</title>"),
        ("<select>", "</select>"),
    ],
)
def test_markup_hidden_by_an_ancestor_or_raw_text_is_not_an_apply_affordance(opening, closing):
    hidden = opening + APPLY_LINK + closing
    assert _direct_apply_url(hidden, DETAIL) is None
    assert _direct_apply_url(hidden + APPLY_LINK, DETAIL) == DIRECT


def test_only_visible_link_text_counts_and_exact_duplicate_targets_are_allowed():
    hidden_label = APPLY_LINK.replace("Apply Online", "<span hidden>Apply Online</span>")
    visible_label = APPLY_LINK.replace("Apply Online", "<span>Apply </span><b>Online</b>")
    assert _direct_apply_url(hidden_label, DETAIL) is None
    assert _direct_apply_url(visible_label + APPLY_LINK, DETAIL) == DIRECT


@pytest.mark.parametrize(
    ("section", "has_link", "redirects", "use_direct"),
    [
        ("123", True, False, True),
        ("123", False, False, False),
        ("123", True, True, False),
        ("external", True, False, False),
    ],
)
def test_scan_preserves_provenance_and_exports_the_application_url(
    section, has_link, redirects, use_direct, monkeypatch
):
    detail = DETAIL.replace("/123/", f"/{section}/")
    calls = []

    def handle(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        if request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "pagingData": {"totalCount": 1},
                    "requisitionList": [
                        {
                            "contestNo": "MA-42",
                            "locationsColumns": [1],
                            "column": ["Software Engineering Intern", "US-MA-Boston"],
                        }
                    ],
                },
            )
        if str(request.url) == detail and redirects:
            return httpx.Response(302, headers={"location": "/landing"})
        assert str(request.url) == detail or (redirects and request.url.path == "/landing")
        return httpx.Response(200, text=APPLY_LINK if has_link else "")

    company = {"name": "Acme", "ats_token": f"acme|{section}|987654"}
    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        [raw] = fetch_taleo_board(client, company)
    expected = DIRECT if use_direct else detail
    assert raw["url"] == raw["source_url"] == detail
    assert raw["apply_url"] == expected
    assert not any("jobapply.ftl" in path for _, path in calls)
    assert company["_scan_complete"] is True

    normalized = normalize(raw)
    assert normalized is not None
    assert normalized["source_url"] == detail
    assert ats_of(expected) == ats_of(detail) == ("taleo", f"acme|{section}")
    assert url_board(expected) == url_board(detail) == ("taleo", f"acme|{section}")
    assert same_job(expected, detail)
    fallback = normalize({**raw, "apply_url": detail})
    assert fallback is not None
    assert normalized["dedupe_key"] == fallback["dedupe_key"]

    engine = create_engine("sqlite://")
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(pipeline, "SessionLocal", sessions)
    monkeypatch.setattr(pipeline, "init_db", lambda: Base.metadata.create_all(engine))
    try:
        pipeline.run([{**raw, "apply_url": detail}], verbose=False)
        with sessions() as db:
            [previous] = db.scalars(select(Listing)).all()
            previous_public = _listing_dict(previous)
        pipeline.run([raw], verbose=False, completed_boards={("taleo", company["ats_token"])})
        with sessions() as db:
            [current] = db.scalars(select(Listing)).all()
            current_public = _listing_dict(current)
            public = shard_row(current_public)
            assert public["id"] == previous_public["id"]
            assert public["ats"] == "taleo"
            assert public["status"] == "open"
            assert public["apply_url"] == expected
            assert current.source_links[0].source_url == detail
        # A filtered but positively observed posting stays open when its URL changes shape.
        assert (
            closed_by_scan([], [previous_public], {("taleo", company["ats_token"])}, [expected])
            == 0
        )
        assert (
            closed_by_scan([], [current_public], {("taleo", company["ats_token"])}, [detail]) == 0
        )
    finally:
        engine.dispose()


def test_taleo_canonicalization_stays_within_the_same_section_tenant_and_job():
    assert same_job(DIRECT, DETAIL)
    assert not same_job(DIRECT.replace("MA-42", "MA-43"), DETAIL)
    assert not same_job(DIRECT.replace("/123/", "/124/"), DETAIL)
    assert not same_job(DIRECT.replace("acme.", "other."), DETAIL)
    assert not same_job(DIRECT.replace("https:", "http:"), DETAIL)
    assert not same_job(DIRECT + "&job=MA-43", DETAIL)
    assert not same_job(DIRECT + "&job=", DETAIL)
    assert not same_job(DIRECT + "&redirect=/other", DETAIL)
    other_detail = DETAIL.replace(".taleo.net", ".example.test")
    other_apply = DIRECT.replace(".taleo.net", ".example.test")
    assert not same_job(other_apply, other_detail)
