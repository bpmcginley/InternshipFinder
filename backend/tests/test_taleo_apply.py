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
        '<a href="jobapply.ftl?lang=en&amp;job=MA-43">Wrong posting</a>',
        '<a href="/careersection/124/jobapply.ftl?lang=en&amp;job=MA-42">Wrong section</a>',
        '<a href="https://other.taleo.net/careersection/123/jobapply.ftl?lang=en&amp;job=MA-42">Wrong tenant</a>',
        '<a href="https:///careersection/123/jobapply.ftl?lang=en&amp;job=MA-42">Incomplete authority</a>',
        '<a href="jobapply.ftl?lang=en&amp;job=MA-42&amp;job=MA-43">Conflicting identifiers</a>',
        '<a href="jobapply.ftl?lang=en&amp;job=MA-42&amp;returnUrl=https://example.test">Unknown parameter</a>',
        '<a href="jobapply.ftl?lang=&amp;job=MA-42">Missing locale</a>',
        '<a href="jobapply.ftl?lang=en&amp;job=MA-42" aria-disabled="true">Disabled</a>',
        '<a href="jobapply.ftl?lang=en&amp;job=MA-42" onclick="return false">Intercepted</a>',
        '<a href="jobapply.ftl?lang=en&amp;job=MA-42" inert>Inert</a>',
        '<template><a href="jobapply.ftl?lang=en&amp;job=MA-42">Template link</a></template>',
        '<noscript><a href="jobapply.ftl?lang=en&amp;job=MA-42">Scripting fallback</a></noscript>',
        '<!-- <a href="jobapply.ftl?lang=en&amp;job=MA-42">Commented-out link</a> -->',
        '<a href="/wrong" href="jobapply.ftl?lang=en&amp;job=MA-42">Conflicting hrefs</a>',
        '<base href="https://other.taleo.net/"><a href="jobapply.ftl?lang=en&amp;job=MA-42">Different base</a>',
    ],
)
def test_ambiguous_or_unavailable_direct_links_fall_back(html):
    assert _direct_apply_url(html, DETAIL) is None


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
        apply_link = '<a href="jobapply.ftl?lang=en&amp;job=MA-42">Apply Online</a>'
        return httpx.Response(200, text=apply_link if has_link else "")

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
            public = shard_row(_listing_dict(current))
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
    finally:
        engine.dispose()


def test_taleo_canonicalization_stays_within_the_same_section_tenant_and_job():
    assert same_job(DIRECT, DETAIL)
    assert not same_job(DIRECT.replace("MA-42", "MA-43"), DETAIL)
    assert not same_job(DIRECT.replace("/123/", "/124/"), DETAIL)
    assert not same_job(DIRECT.replace("acme.", "other."), DETAIL)
    assert not same_job(DIRECT + "&job=MA-43", DETAIL)
    assert not same_job(DIRECT + "&job=", DETAIL)
    assert not same_job(DIRECT + "&redirect=/other", DETAIL)
    other_detail = DETAIL.replace(".taleo.net", ".example.test")
    other_apply = DIRECT.replace(".taleo.net", ".example.test")
    assert not same_job(other_apply, other_detail)
