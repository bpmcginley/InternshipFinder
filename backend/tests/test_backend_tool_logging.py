"""Offline checks for backend operator diagnostics and the unchanged CLI protocols."""

import json

import pytest

from internscout import focus, placements, seo_pages


@pytest.fixture(params=["plain", "json"])
def log_format(request, monkeypatch):
    if request.param == "plain":
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    else:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    return request.param


@pytest.mark.parametrize(
    "scenario,message",
    [
        ("missing", "[focus] no previous export; using the configured focus queries"),
        (
            "bad",
            "[focus] could not read the last export (ValueError); using the configured focus queries",
        ),
        ("full", "[focus] no field is thin; using the configured focus queries"),
        ("thin", "[focus] thinnest fields for UMass majors: psychology (0 open nearby, 1 majors)"),
    ],
)
def test_focus_diagnostics_preserve_selection_and_plain_stdout(
    scenario, message, log_format, monkeypatch, tmp_path, capsys
):
    export_dir = tmp_path / "data"
    index = export_dir / "listings" / "index.json"
    if scenario != "missing":
        index.parent.mkdir(parents=True)
        index.touch()

    def load(site):
        assert site == str(tmp_path)
        if scenario == "bad":
            raise ValueError("synthetic provider value")
        assert scenario in {"full", "thin"}
        return {
            "listings": [],
            "majors": [{"tags": ["psychology"], "level": "undergrad"}]
            if scenario == "thin"
            else [],
        }

    monkeypatch.setattr(seo_pages, "load", load)
    fallback = ["configured query"]
    expected = focus.SEARCHES["psychology"] if scenario == "thin" else fallback
    assert focus.choose(str(export_dir), fallback) == expected
    captured = capsys.readouterr()
    assert captured.err == ""
    if log_format == "plain":
        assert captured.out == message + "\n"
    else:
        record = {"level": "INFO", "message": message}
        if scenario == "bad":
            record.update(level="WARNING", exception_type="ValueError")
        assert json.loads(captured.out) == record


def test_placement_success_log_has_only_the_record_count(log_format, monkeypatch, capsys):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "fixture-value")
    calls = []

    def record(report_path, token):
        calls.append((report_path, token))
        return 3

    monkeypatch.setattr(placements, "record_runs", record)
    assert placements.main(["placements", "record", "local-report.json"]) == 0
    assert calls == [("local-report.json", "fixture-value")]
    captured = capsys.readouterr()
    assert captured.err == ""
    message = "[placements] recorded today's runs for 3 placement(s)"
    if log_format == "plain":
        assert captured.out == message + "\n"
    else:
        assert json.loads(captured.out) == {"level": "INFO", "message": message}


def test_placement_annotations_and_usage_stay_raw_in_json_mode(monkeypatch, capsys):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    assert placements.main(["placements"]) == 2
    assert placements.main(["placements", "record", "local-report.json"]) == 0
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "fixture-value")

    def record(_report_path, _token):
        raise FileNotFoundError

    monkeypatch.setattr(placements, "record_runs", record)
    assert placements.main(["placements", "record", "local-report.json"]) == 0
    captured = capsys.readouterr()
    assert captured.err == "usage: python -m internscout.placements record REPORT\n"
    assert captured.out == (
        "::warning::paid listing runs not recorded: no Cloudflare token in this run\n"
        "::warning::paid listing runs not recorded: no report file\n"
    )
