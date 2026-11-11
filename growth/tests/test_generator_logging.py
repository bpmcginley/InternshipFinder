"""Local diagnostics for growth artifact generators."""

import json

import pytest

from growth import every_major_list, title_discovery


@pytest.fixture(params=[False, True])
def json_mode(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    return request.param


def test_every_major_success_keeps_default_text_and_redacts_path(json_mode, monkeypatch, capsys):
    calls = []
    files = {"README.md": "Summary", "fields/finance.md": "Details"}

    def build(site, live, repo):
        calls.append((site, live, repo))
        return files

    monkeypatch.setattr(every_major_list, "build", build)
    monkeypatch.setattr(every_major_list, "write", lambda out, actual: calls.append((out, actual)))
    assert (
        every_major_list.main(["every_major_list", "local-site", "--out", "local-output"]) is None
    )
    assert calls == [("local-site", {}, every_major_list.REPO), ("local-output", files)]
    result = capsys.readouterr()
    assert result.err == ""
    summary = "[list] wrote README.md (7 bytes) and 1 field files"
    if json_mode:
        assert json.loads(result.out) == {"level": "INFO", "message": summary}
    else:
        assert result.out == summary + " into local-output\n"


def test_title_discovery_success_keeps_default_text_and_redacts_path(
    json_mode, monkeypatch, capsys
):
    calls = []

    def build(site, out):
        calls.append((site, out))
        return {"sheets": [{}, {}]}

    monkeypatch.setattr(title_discovery, "build", build)
    assert title_discovery.main(["local-site", "--out", "local-output"]) == 0
    assert calls == [("local-site", "local-output")]
    result = capsys.readouterr()
    assert result.err == ""
    summary = "[title-discovery] wrote 2 draft sheets"
    if json_mode:
        assert json.loads(result.out) == {"level": "INFO", "message": summary + "; nothing posted"}
    else:
        assert result.out == summary + " to local-output; nothing posted\n"


def test_title_discovery_refusal_stays_raw_on_stderr(json_mode, monkeypatch, capsys):
    def build(*_args):
        raise ValueError("no qualifying listing")

    monkeypatch.setattr(title_discovery, "build", build)
    assert title_discovery.main([]) == 1
    result = capsys.readouterr()
    assert result.out == ""
    assert result.err == "[title-discovery] refused: no qualifying listing\n"
