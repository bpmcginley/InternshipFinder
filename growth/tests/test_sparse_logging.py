"""Offline compatibility checks for diagnostics in sparse-workflow scripts."""

import json

import pytest

from growth import catchup, indexnow


@pytest.fixture(params=[False, True], ids=["plain", "json"])
def structured(request, monkeypatch):
    if request.param:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    else:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    return request.param


def test_indexnow_preserves_usage_and_raw_rejection(monkeypatch, capsys, structured):
    assert indexnow.main(["indexnow.py"]) == 2
    assert capsys.readouterr().out == indexnow.__doc__ + "\n"
    uri = "https://internscout.org/example/"
    monkeypatch.setattr(indexnow, "entries", lambda path: {} if path == "old" else {uri: "today"})
    calls = []

    def submit(urls):
        calls.append(urls)
        return [202, 503]

    monkeypatch.setattr(indexnow, "submit", submit)
    assert indexnow.main(["indexnow.py", "old", "new", "--submit"]) == 1
    assert calls == [[uri]]
    captured = capsys.readouterr()
    assert captured.err == ""
    lines = captured.out.splitlines()
    assert lines[-1] == (
        "::error::IndexNow did not accept every batch; the site deployed, "
        "but recrawl notification needs attention"
    )
    expected = [
        "[indexnow] 1 changed: 1 new, 0 removed, 0 updated",
        "[indexnow] submitted, HTTP [202, 503]",
    ]
    if structured:
        assert [json.loads(line) for line in lines[:-1]] == [
            {"level": "INFO", "message": line} for line in expected
        ]
    else:
        assert captured.out == "\n".join([*expected, lines[-1], ""])


def test_indexnow_empty_sitemap_path_stays_in_plain_only(monkeypatch, capsys, structured):
    monkeypatch.setattr(indexnow, "entries", lambda path: {})
    target = "some-local-directory/new.xml"
    assert indexnow.main(["indexnow.py", "old.xml", target]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    if structured:
        assert json.loads(captured.out) == {
            "level": "INFO",
            "message": "[indexnow] new sitemap has no URLs; nothing sent",
        }
    else:
        assert captured.out == f"[indexnow] {target} has no URLs; nothing sent\n"


def test_catchup_guard_output_file_remains_raw(monkeypatch, tmp_path, capsys, structured):
    output = tmp_path / "github-output"
    output.write_text("earlier=value\n", encoding="utf-8")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    calls = []

    def guard(file, now):
        calls.append(file)
        return True

    monkeypatch.setattr(catchup, "guard", guard)
    assert catchup.main(["catchup.py", "--guard", "local-name.yml"]) == 0
    assert calls == ["local-name.yml"]
    assert output.read_text(encoding="utf-8") == "earlier=value\nskip=true\n"
    captured = capsys.readouterr()
    assert captured.err == ""
    suffix = "another run already did this slot's work; skipping"
    if structured:
        assert json.loads(captured.out) == {
            "level": "INFO",
            "message": f"[catchup] guard: {suffix}",
        }
    else:
        assert captured.out == f"[catchup] local-name.yml: {suffix}\n"


def test_catchup_failure_preserves_dispatch_and_redacts_exception(monkeypatch, capsys, structured):
    sent = []

    def runs(file):
        if file == "ingest.yml":
            raise OSError("provider response detail")
        return []

    def call(method, path, body=None):
        sent.append((method, path, body))
        return {}

    monkeypatch.setattr(catchup, "runs", runs)
    monkeypatch.setattr(catchup, "_call", call)
    monkeypatch.setattr(catchup, "digest_due", lambda rs, now: True)
    monkeypatch.setattr(catchup, "post_due", lambda rs, now: True)
    assert catchup.main(["catchup.py"]) == 1
    assert sent == [
        ("POST", "workflows/metrics.yml/dispatches", {"ref": "main"}),
        (
            "POST",
            "workflows/digest.yml/dispatches",
            {"ref": "main", "inputs": {"everyone": "true", "check_key": "false"}},
        ),
        ("POST", "workflows/social.yml/dispatches", {"ref": "main", "inputs": {"force": "false"}}),
    ]
    expected = [
        "[catchup] ingest.yml: check failed (OSError)",
        "[catchup] metrics.yml: overdue, started",
        "[catchup] digest.yml: this Monday's email had not started, started",
        "[catchup] social.yml: today's post had not started, started",
    ]
    captured = capsys.readouterr()
    assert captured.err == ""
    if structured:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {"level": "WARNING", "message": expected[0], "exception_type": "OSError"},
            *({"level": "INFO", "message": line} for line in expected[1:]),
        ]
    else:
        assert captured.out == "\n".join(expected) + "\n"
