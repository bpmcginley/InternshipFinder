"""Public export overrides and the existing site-relative and explicit input paths."""

import json

from internscout import focus
from internscout.public_data import PUBLIC_DATA_ENV, public_data_dir
from internscout.site import source


def _export(folder, field):
    (folder / "listings").mkdir(parents=True)
    (folder / "listings" / "index.json").write_text('{"files": {}}', encoding="utf-8")
    (folder / "majors.json").write_text(
        json.dumps({"majors": [{"tags": [field], "level": "undergrad"}]}), encoding="utf-8"
    )


def test_public_location_defaults_to_existing_site_data(monkeypatch, tmp_path):
    monkeypatch.setenv("INTERNSCOUT_DATA", str(tmp_path / "private"))
    monkeypatch.delenv(PUBLIC_DATA_ENV, raising=False)
    assert public_data_dir() == "docs/data"
    assert public_data_dir(tmp_path) == str(tmp_path / "data")
    monkeypatch.setenv(PUBLIC_DATA_ENV, "")
    assert public_data_dir(tmp_path) == str(tmp_path / "data")


def test_source_uses_public_override_and_honors_explicit_input(monkeypatch, tmp_path):
    site = tmp_path / "site"
    selected = tmp_path / "external"
    _export(site / "data", "psychology")
    _export(selected, "chemistry")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv(PUBLIC_DATA_ENV, raising=False)
    assert source.load(str(site))["majors"][0]["tags"] == ["psychology"]
    monkeypatch.setenv(PUBLIC_DATA_ENV, "external")
    assert source.load(str(site))["majors"][0]["tags"] == ["chemistry"]
    assert source.load(str(site), data_dir=str(site / "data"))["majors"][0]["tags"] == [
        "psychology"
    ]


def test_focus_reads_matching_public_export_and_keeps_legacy_explicit_fallback(
    monkeypatch, tmp_path
):
    legacy = tmp_path / "site"
    named = legacy / "custom"
    external = tmp_path / "external"
    _export(legacy / "data", "psychology")
    _export(named, "chemistry")
    _export(external, "chemistry")
    fallback = ["configured query"]

    monkeypatch.delenv(PUBLIC_DATA_ENV, raising=False)
    assert focus.choose(str(named), fallback) == focus.SEARCHES["psychology"]
    monkeypatch.setenv(PUBLIC_DATA_ENV, str(external))
    assert focus.choose(str(external), fallback) == focus.SEARCHES["chemistry"]
    assert focus.choose(str(named), fallback) == focus.SEARCHES["psychology"]
