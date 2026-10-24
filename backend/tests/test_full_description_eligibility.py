"""2026-10-23: eligibility uses fetched evidence before public trimming (DQ-1)."""
import json
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from internscout import export_static, pipeline
from internscout.db import Base
from internscout.insights import extract
from internscout.models import Listing
from internscout.sources import common, greenhouse, workday

FIXTURE = json.loads((Path(__file__).parent / "fixtures/cvs-r1080767-description.json").read_text(encoding="utf-8"))


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'full-source.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    for mod in (pipeline, export_static):
        monkeypatch.setattr(mod, "SessionLocal", sessions)
        monkeypatch.setattr(mod, "init_db", lambda: None)
    yield sessions
    engine.dispose()


def source_item(adapter):
    """Offline: replay the retained public CVS description into two adapter shapes."""
    common._ROBOTS.clear()
    def handle(request):
        if request.url.path.endswith("robots.txt"):
            return httpx.Response(404)
        if request.method == "POST":
            return httpx.Response(200, json={"total": 1, "jobPostings": [{
                "title": FIXTURE["title"], "externalPath": "/job/Hartford/Intern_R1080767",
                "locationsText": "Hartford, CT"}]})
        if request.url.path.endswith("/jobs"):
            return httpx.Response(200, json={"jobs": [{"id": 1, "title": FIXTURE["title"],
                "location": {"name": "Hartford, CT"}, "absolute_url": "https://boards.greenhouse.io/fixture/jobs/1"}]})
        return httpx.Response(200, json={"content": FIXTURE["jobDescription"], "jobPostingInfo": {
            "location": "Hartford, CT", "jobDescription": FIXTURE["jobDescription"]}})
    try:
        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            co = {"name": "CVS Health", "ats_token": "cvshealth|wd1|CVS_Health_Careers" if adapter == "workday" else "fixture"}
            fetch = workday.fetch_workday_board if adapter == "workday" else greenhouse.fetch_greenhouse_board
            items = fetch(client, co)
        assert len(items) == 1
        return items[0]
    finally:
        common._ROBOTS.clear()


@pytest.mark.parametrize("adapter", ["workday", "greenhouse"])
def test_real_graduation_window_survives_adapter_persistence_and_public_trimming(adapter, isolated_db, tmp_path):
    raw = source_item(adapter)
    # This retained employer response reproduces the old cap without fabricated qualifications.
    assert len(raw["description"]) == 5508
    assert extract(raw["description"][:4000])["grad_years"] == [2027]
    assert extract(raw["description"])["grad_years"] == [2027, 2028]
    assert pipeline.run([raw], verbose=False)["new"] == 1
    with isolated_db() as db:
        assert db.scalar(select(Listing)).description == raw["description"]
    out = tmp_path / "public"
    export_static.export(str(out))
    row, = export_static.previous_export(str(out))
    assert row["insights"]["grad_years"] == [2027, 2028], "2028 graduates must not be falsely excluded"
    assert row["insights_text_version"] == export_static.INSIGHTS_TEXT_VERSION
    assert len(row["description"]) == export_static.DESC_CHARS == 1500
    assert "grad_years" not in extract(row["description"]), "the excerpt cannot reconstruct eligibility"


def test_carried_export_preserves_full_source_insights_without_reparsing_excerpt(isolated_db, tmp_path):
    raw = source_item("workday")
    pipeline.run([raw], verbose=False)
    out = tmp_path / "public"
    export_static.export(str(out))
    before, = export_static.previous_export(str(out))
    with isolated_db() as db:
        db.delete(db.scalar(select(Listing)))
        db.commit()
    result = export_static.export(str(out), observed_urls=[raw["apply_url"]])
    after, = export_static.previous_export(str(out))
    assert result["held"] == 1
    assert after["carried"] is True
    assert after["insights"] == before["insights"]
    assert after["insights"]["grad_years"] == [2027, 2028]
    assert after["description"] == before["description"]
    assert after["last_seen"] == before["last_seen"]


@pytest.mark.parametrize("search_only", [False, True])
def test_legacy_public_export_removes_unverified_graduation_blocker_on_carry(search_only, isolated_db, tmp_path):
    raw = source_item("workday")
    pipeline.run([raw], verbose=False)
    out = tmp_path / "public"
    export_static.export(str(out))
    legacy, = export_static.previous_export(str(out))
    legacy.pop("insights_text_version")
    legacy["insights"]["grad_years"] = [2027]  # the audit's old, truncated extraction
    if search_only:
        legacy["via_search"] = True
        legacy["ats"] = None
    other = {k: v for k, v in legacy["insights"].items() if k != "grad_years"}
    export_static.write_shards([legacy], str(out), legacy["last_seen"])
    with isolated_db() as db:
        db.delete(db.scalar(select(Listing)))
        db.commit()
    export_static.export(str(out), observed_urls=[raw["apply_url"]])
    carried, = export_static.previous_export(str(out))
    assert carried["carried"] is True
    assert carried["insights"] == other
    assert carried["last_seen"] == legacy["last_seen"]
    assert "insights_text_version" not in carried, "carryover must not claim a fresh full-source read"


def test_legacy_carried_graduation_limits_become_unknown_without_guessing_or_losing_other_insights():
    old = {"carried": True, "insights": {"grad_years": [2027], "no_sponsorship": True,
        "skills": [{"name": "Agile", "level": "required"}]}, "last_seen": "2026-10-22T12:00:00Z"}
    verified = {"carried": True, "insights_text_version": export_static.INSIGHTS_TEXT_VERSION,
        "insights": {"grad_years": [2027, 2028]}}
    fresh = {"insights_text_version": export_static.INSIGHTS_TEXT_VERSION,
        "insights": {"grad_years": [2028]}}
    export_static.discard_legacy_grad_windows([old, verified, fresh])
    assert old["insights"] == {"no_sponsorship": True, "skills": [{"name": "Agile", "level": "required"}]}
    assert old["last_seen"] == "2026-10-22T12:00:00Z"
    assert verified["insights"]["grad_years"] == [2027, 2028]
    assert fresh["insights"]["grad_years"] == [2028]
