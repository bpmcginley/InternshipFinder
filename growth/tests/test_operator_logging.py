"""Offline console checks for growth operator reports."""

import json
import runpy
import sys
from pathlib import Path

import pytest

from growth import audience, outreach


@pytest.fixture(params=[False, True], ids=["plain", "json"])
def use_json(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    return request.param


@pytest.fixture(params=["package", "script"])
def run_cli(request, monkeypatch):
    def run(module, *args):
        script = Path(module.__file__)
        monkeypatch.setattr(sys, "argv", [str(script), *args])
        if request.param == "script":
            monkeypatch.syspath_prepend(str(script.parent))
            runpy.run_path(str(script), run_name="__main__")
        else:
            module.main()

    return run


def test_audience_report_preserves_whitespace_and_tier_order(
    monkeypatch, capsys, run_cli, use_json
):
    generated = "2026-01-02T00:00:00+00:00"
    names = ("Primary Major", "Secondary Major", "Serviceable Major", "Thin Major")
    tags = ("swe", "biology", "music", "finance")
    data = {
        "generated_at": generated,
        "majors": [
            {"name": name, "tags": [tag], "level": "undergrad"} for name, tag in zip(names, tags)
        ],
        "listings": [
            {"field_tags": [tag], "keys": {"MA"}}
            for tag, count in zip(tags, (200, 100, 10, 0))
            for _ in range(count)
        ],
    }
    calls = []

    def load(site):
        calls.append(site)
        return data

    monkeypatch.setattr(audience.seo_pages, "load", load)
    run_cli(audience, "mock-site")
    assert calls == ["mock-site"]
    expected = [
        f"Data from {generated}\n",
        "Primary: market now (1)",
        "    200 nearby     200 nationwide  Primary Major",
        "",
        "Secondary (1)",
        "    100 nearby     100 nationwide  Secondary Major",
        "",
        "Serviceable (1)",
        "     10 nearby      10 nationwide  Serviceable Major",
        "",
        "Not yet: fix the data first (1)",
        "      0 nearby       0 nationwide  Thin Major",
        "",
    ]
    captured = capsys.readouterr()
    assert captured.err == ""
    if use_json:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {"level": "INFO", "message": line} for line in expected
        ]
    else:
        assert captured.out == "\n".join(expected) + "\n"


def test_outreach_cli_keeps_draft_artifacts_and_redacts_local_path(
    monkeypatch, tmp_path, capsys, run_cli, use_json
):
    monkeypatch.setattr(
        outreach.sp, "load", lambda site: {"generated_at": None, "majors": [], "listings": []}
    )
    dest = tmp_path / "operator-draft-output"
    run_cli(outreach, "mock-site", "--out", str(dest))
    assert sorted(p.name for p in dest.iterdir()) == ["drafts.json", "drafts.txt"]
    kit = json.loads((dest / "drafts.json").read_text(encoding="utf-8"))
    assert kit["status"] == "stale"
    assert kit["majors"] == []
    assert (dest / "drafts.txt").read_text(encoding="utf-8") == outreach.render(kit)
    captured = capsys.readouterr()
    assert captured.err == ""
    if use_json:
        assert json.loads(captured.out) == {
            "level": "INFO",
            "message": "[outreach] 0 drafts; status=stale; wrote drafts",
        }
        assert str(dest) not in captured.out
    else:
        assert captured.out == f"[outreach] 0 drafts; status=stale; wrote {dest}\n"
