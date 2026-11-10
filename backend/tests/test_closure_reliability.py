"""Offline regressions: absence needs a complete scan of the exact employer board."""
import sys
from unittest.mock import Mock

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from internscout import pipeline, run_ingest
from internscout.db import Base
from internscout.models import Listing


@pytest.fixture
def listing_db(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'closure.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(pipeline, "SessionLocal", sessions)
    monkeypatch.setattr(pipeline, "init_db", lambda: None)
    yield sessions
    engine.dispose()


def item(board, *, source="greenhouse", title="Software Engineer Intern"):
    return dict(company_name=f"Employer {board}", title=title,
                locations=["Boston, MA"], source=source,
                url=f"https://boards.greenhouse.io/{board}/jobs/123")


def statuses(sessions):
    with sessions() as db:
        return {row.company_name: row.status for row in db.scalars(select(Listing))}


def test_pipeline_metrics_explain_normalization_and_filter_losses(listing_db):
    from internscout.ingest_metrics import IngestMetrics
    metrics = IngestMetrics()
    pipeline.run([item("kept"), item("staff", title="Senior Engineer"),
                  dict(item("foreign"), locations=["Paris, France"])],
                 verbose=False, metrics=metrics)
    report = metrics.as_dict()
    assert report["funnel"] == {"fetched": 3, "parsed": 2, "accepted": 1, "unique": 1, "persisted": 1}
    assert report["rejections"]["normalize"] == {"not_student_role": 1}
    assert report["rejections"]["filter"] == {"outside_region": 1}
    assert report["discrepancies"] == []


def test_one_successful_board_cannot_close_failed_neighbor(listing_db):
    pipeline.run([item("healthy"), item("failed")], verbose=False)
    pipeline.run([item("healthy")], completed_boards={("greenhouse", "healthy")}, verbose=False)
    assert statuses(listing_db) == {"Employer healthy": "open", "Employer failed": "open"}


def test_successfully_empty_exact_board_can_close(listing_db):
    pipeline.run([item("gone"), item("unscanned")], verbose=False)
    stats = pipeline.run([], completed_boards={("greenhouse", "gone")}, verbose=False)
    assert stats["closed"] == 1
    assert statuses(listing_db) == {"Employer gone": "closed", "Employer unscanned": "open"}


@pytest.mark.parametrize("source", ["google_jobs", "vanshb03", "speedyapply", "greenhouse"])
def test_partial_source_refresh_does_not_close_missing_listings(listing_db, source):
    pipeline.run([item("first", source=source), item("second", source=source)], verbose=False)
    pipeline.run([item("first", source=source)], verbose=False)
    assert all(status == "open" for status in statuses(listing_db).values())


def test_search_discovery_does_not_block_authoritative_employer_closure(listing_db):
    raw = item("gone", source="google_jobs")
    raw["source_url"] = "https://www.google.com/search?q=internships"
    pipeline.run([raw], verbose=False)
    assert pipeline.run([], completed_boards={("greenhouse", "GONE")}, verbose=False)["closed"] == 1


def test_unresolved_board_provenance_is_retained(listing_db):
    raw = item("unknown")
    raw["url"] = "https://employer.example/careers/123"
    pipeline.run([raw], verbose=False)
    assert pipeline.run([], completed_boards={("greenhouse", "other")}, verbose=False)["closed"] == 0


def test_raw_presence_protects_posting_when_its_metadata_is_rejected(listing_db):
    raw = item("stillthere")
    pipeline.run([raw], verbose=False)
    # An incomplete enrichment/location response is not a removed posting.
    stats = pipeline.run([{**raw, "locations": []}],
                         completed_boards={("greenhouse", "stillthere")}, verbose=False)
    assert stats["kept"] == 0 and stats["closed"] == 0


def test_scan_records_complete_empty_board_but_not_failed_or_capped(monkeypatch):
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)

    def fetch(c, co):
        if co["ats_token"] == "failed":
            raise ValueError("malformed response")
        if co["ats_token"] == "complete":
            co["_scan_complete"] = True
        return []  # capped and empty are indistinguishable without evidence

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "greenhouse", fetch)
    reg = {"greenhouse": {token: {"name": token, "fails": 0}
                          for token in ("complete", "failed", "capped")}}
    complete = set()
    assert run_ingest.scan_boards(reg, workers=1, verbose=False, completed_boards=complete) == []
    assert complete == {("greenhouse", "complete")}


@pytest.mark.parametrize("ats,payload", [
    ("greenhouse", {"jobs": []}), ("lever", []),
    ("ashby", {"jobs": []}), ("recruitee", {"offers": []}),
])
def test_valid_empty_responses_are_explicitly_complete(monkeypatch, ats, payload):
    from internscout.sources import recruitee
    monkeypatch.setattr(recruitee, "require_robots", lambda *a: None)
    c = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        result = run_ingest._fetch_board(c, ats, {"name": "Empty", "ats_token": "empty"})
        assert result == [] and result.complete is True
    finally:
        c.close()


@pytest.mark.parametrize("ats", ["greenhouse", "lever", "ashby", "recruitee"])
def test_malformed_success_response_cannot_authorize_closure(monkeypatch, ats):
    from internscout.sources import recruitee
    monkeypatch.setattr(recruitee, "require_robots", lambda *a: None)
    c = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})))
    co = {"name": "Broken", "ats_token": "broken", "_scan_complete": True}
    try:
        with pytest.raises(ValueError):
            run_ingest._fetch_board(c, ats, co)
        assert "_scan_complete" not in co
    finally:
        c.close()


@pytest.mark.parametrize("flag", ["--ats", "--lists", "--google"])
def test_cli_partial_modes_pass_only_explicit_board_evidence(monkeypatch, flag):
    # No network, registry writes, production DB or paid search calls.
    monkeypatch.setattr(sys, "argv", ["run_ingest", flag])
    for name in ("seed_registry", "discover", "probe_boards", "label_boards", "label_sectors", "prune", "refused_count"):
        monkeypatch.setattr(run_ingest, name, lambda *a: 0)
    for name in ("save_registry", "save_cache"):
        monkeypatch.setattr(run_ingest, name, lambda *a: None)
    monkeypatch.setattr(run_ingest, "load_registry", lambda: {})
    monkeypatch.setattr(run_ingest, "fetch_github_lists", lambda **kw: [])
    monkeypatch.setattr(run_ingest, "fetch_google_jobs", lambda *a, **kw: [])

    def scan(reg, workers, *, completed_boards, metrics=None):
        completed_boards.add(("greenhouse", "complete"))
        return []

    monkeypatch.setattr(run_ingest, "scan_boards", scan)
    persist = Mock()
    monkeypatch.setattr(run_ingest, "run", persist)
    run_ingest.main()
    expected = {("greenhouse", "complete")} if flag == "--ats" else set()
    assert persist.call_args.kwargs["completed_boards"] == expected
