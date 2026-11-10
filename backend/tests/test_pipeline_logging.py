"""Offline checks for the ingest and export console formats."""

import json
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from internscout import export_static, pipeline, run_ingest
from internscout.db import Base
from internscout.models import Listing


@pytest.fixture(params=["plain", "json"])
def log_format(request, monkeypatch):
    if request.param == "plain":
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    else:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    return request.param


@pytest.fixture
def sessions(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (export_static, pipeline):
        monkeypatch.setattr(module, "SessionLocal", factory)
        monkeypatch.setattr(module, "init_db", lambda: None)
    yield factory
    engine.dispose()


def test_pipeline_source_log_omits_raw_labels_only_in_json(sessions, capsys, log_format):
    stats = pipeline.run(
        [
            {
                "company_name": "Example Employer",
                "title": "Software Engineer Intern",
                "locations": ["Boston, MA"],
                "source": "fixture-raw-source",
                "url": "https://example.test/role",
            }
        ]
    )
    captured = capsys.readouterr()
    assert captured.err == ""
    lines = [
        f"[pipeline] {stats}; 0 bare town names placed by their board",
        "[pipeline] by state: {'MA': 1}",
        "[pipeline] by source: {'fixture-raw-source': 1}",
    ]
    if log_format == "plain":
        assert captured.out == "\n".join(lines) + "\n"
    else:
        lines[-1] = "[pipeline] source associations: 1, distinct source names: 1"
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {"level": "INFO", "message": line} for line in lines
        ]


def test_export_location_log_omits_raw_examples_only_in_json(
    sessions, tmp_path, capsys, log_format
):
    with sessions.begin() as db:
        db.add(
            Listing(
                dedupe_key="fixture-unplaced",
                company_name="Fixture Employer",
                title="Software Engineer Intern",
                location_raw="Fixture Unmapped Location",
                stage=["internship"],
            )
        )

    out = str(tmp_path / "export")
    export_static.export(out)
    captured = capsys.readouterr()
    assert captured.err == ""
    message = (
        "[export] 1 listings name no US location today's rules can place, so "
        "they are in no state file and the site cannot show them"
    )
    lines = captured.out.splitlines()
    assert len(lines) == 5
    if log_format == "plain":
        assert lines[-2] == f"[export] wrote 0 listings (0 state files) to {out}"
        assert lines[-1] == message + ": Fixture Employer - Fixture Unmapped Location"
    else:
        assert json.loads(lines[-2]) == {
            "level": "INFO",
            "message": "[export] wrote 0 listings (0 state files)",
        }
        assert json.loads(lines[-1]) == {"level": "INFO", "message": message}
        assert all(json.loads(line)["level"] == "INFO" for line in lines)
        assert "Fixture Employer" not in captured.out
        assert "Fixture Unmapped Location" not in captured.out


def test_board_exception_log_is_opt_in_and_only_reports_type(monkeypatch, capsys, log_format):
    def fail(c, board):
        raise ValueError("fixture raw provider message")

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fixtureats", fail)
    monkeypatch.setattr(run_ingest, "client", nullcontext)
    monkeypatch.setattr(run_ingest, "time", SimpleNamespace(monotonic=iter([0, 7]).__next__))
    reg = {"fixtureats": {"fixture-board": {"name": "Fixture Board", "fails": 0}}}
    assert run_ingest.scan_boards(reg, workers=1) == []
    assert reg["fixtureats"]["fixture-board"]["fails"] == 1

    captured = capsys.readouterr()
    assert captured.err == ""
    lines = [
        "[boards] 1 boards in 7s (0 of 0 transient failures retried); "
        "intern postings {}; failed boards {'fixtureats': 1}",
        "[boards] failure causes {'fixtureats': {'ValueError': 1}}",
    ]
    if log_format == "plain":
        assert captured.out == "\n".join(lines) + "\n"
    else:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {
                "level": "WARNING",
                "message": "[boards] board fetch failed",
                "exception_type": "ValueError",
            },
            *({"level": "INFO", "message": line} for line in lines),
        ]
