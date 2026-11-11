"""Offline checks for backend error telemetry and the asset CLI protocol."""

import contextlib
import io
import json
from types import SimpleNamespace

import httpx
import pytest

from internscout import asset_versions, geo, probe


@pytest.fixture(params=[False, True], ids=["plain", "json"])
def json_log(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    return request.param


def test_asset_error_uses_stderr_and_leaves_success_json_raw(tmp_path, capsys, json_log):
    (tmp_path / "app.js").write_text("example", encoding="utf-8")
    html = tmp_path / "index.html"
    html.write_text('<script src="app.js"></script>', encoding="utf-8")
    assert asset_versions.main([str(tmp_path)]) == 0
    success = capsys.readouterr()
    assert success.out == '{"asset_references": 1, "changed_files": 1, "html_files": 1}\n'
    assert success.err == ""

    invalid = '<script src="synthetic-missing.js?detail=synthetic-private"></script>'
    html.write_text(invalid, encoding="utf-8")
    assert asset_versions.main([str(tmp_path)]) == 1
    assert html.read_text(encoding="utf-8") == invalid
    error = capsys.readouterr()
    assert error.out == ""
    message = "Asset versioning failed: Local asset is missing or invalid"
    if json_log:
        assert json.loads(error.err) == {
            "level": "ERROR",
            "message": message,
            "exception_type": "AssetVersionError",
        }
    else:
        assert error.err == message + "\n"


def test_geocode_failure_keeps_rate_and_cache_fallback(monkeypatch, capsys, json_log):
    cache, waits = {}, []
    monkeypatch.setattr(geo, "_load_cache", lambda: cache)
    monkeypatch.setattr(geo, "_budget", 2)
    monkeypatch.setattr(geo, "_last_call", 99.5)
    monkeypatch.setattr(geo, "_dirty", False)
    monkeypatch.setattr(
        geo, "time", SimpleNamespace(monotonic=iter([100.0, 101.25]).__next__, sleep=waits.append)
    )

    def request(*args, **kwargs):
        raise TimeoutError("synthetic provider request")

    monkeypatch.setattr(httpx, "get", request)
    assert geo._nominatim("Synthetic City", "NY") is None
    assert waits == [pytest.approx(0.6)]
    assert geo._last_call == 101.25 and geo._budget == 1
    assert not cache and not geo._dirty

    captured = capsys.readouterr()
    assert captured.err == ""
    if json_log:
        assert json.loads(captured.out) == {
            "level": "WARNING",
            "message": "[geo] geocoding request failed",
            "exception_type": "TimeoutError",
        }
    else:
        assert captured.out == ""


def test_probe_failures_keep_the_original_fallbacks(monkeypatch, capsys, json_log):
    calls = []

    def request(url, **kwargs):
        calls.append(url)
        raise TimeoutError("synthetic provider request")

    client = SimpleNamespace(get=request)
    assert probe._serves_job(client, "synthetic-board", "synthetic-job") is False

    monkeypatch.setattr(probe, "slugs_for", lambda name: ["synthetic-board"])
    monkeypatch.setattr(probe, "_serves_job", lambda c, token, jid: token == "synthetic-board")
    assert (
        probe.gh_host_token(client, "https://example.test/roles", "synthetic-job", "Synthetic Name")
        == "synthetic-board"
    )
    assert len(calls) == 2

    checked = []

    def bad(_client, slug, _name):
        checked.append(("first", slug))
        raise ValueError("synthetic board detail")

    def good(_client, slug, _name):
        checked.append(("second", slug))
        return True

    monkeypatch.setattr(probe, "PROBES", [("first", bad), ("second", good)])
    assert probe._probe_one(client, "Synthetic Name") == ("second", "synthetic-board")
    assert checked == [("first", "synthetic-board"), ("second", "synthetic-board")]

    captured = capsys.readouterr()
    assert captured.err == ""
    if json_log:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {"level": "WARNING", "message": message, "exception_type": kind}
            for message, kind in (
                ("[probe] Greenhouse job check failed", "TimeoutError"),
                ("[probe] Greenhouse careers page lookup failed", "TimeoutError"),
                ("[probe] board candidate check failed", "ValueError"),
            )
        ]
    else:
        assert captured.out == ""


def test_probe_fallback_survives_an_unavailable_json_stream(monkeypatch):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    writes = []

    class UnavailableStream(io.StringIO):
        def write(self, message):
            writes.append(message)
            raise RuntimeError("synthetic console failure")

    def bad(_client, _slug, _name):
        raise ValueError("synthetic board detail")

    monkeypatch.setattr(probe, "slugs_for", lambda name: ["synthetic-board"])
    monkeypatch.setattr(probe, "PROBES", [("first", bad), ("second", lambda *args: True)])
    with contextlib.redirect_stdout(UnavailableStream()):
        assert probe._probe_one(None, "Synthetic Name") == ("second", "synthetic-board")
    assert len(writes) == 1
