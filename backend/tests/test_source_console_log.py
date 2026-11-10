import json

import httpx
import pytest
from internscout.sources import common, houseai, uhn


@pytest.fixture(params=[None, "json"])
def log_format(monkeypatch, request):
    if request.param is None:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    else:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", request.param)
    return request.param


def test_robots_lookup_failure_keeps_the_cached_default(monkeypatch, capsys, log_format):
    monkeypatch.setattr(common, "_ROBOTS", {})
    calls = []

    def respond(request):
        calls.append(request.url.path)
        raise RuntimeError("synthetic private request detail")

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert common.robots_allows(client, "https://board.test", "/first")
        assert common.robots_allows(client, "https://board.test", "/next")

    assert calls == ["/robots.txt"]
    captured = capsys.readouterr()
    assert captured.err == ""
    if log_format is None:
        assert captured.out == ""
    else:
        assert json.loads(captured.out) == {
            "level": "WARNING",
            "message": "[sources] robots lookup failed",
            "exception_type": "RuntimeError",
        }


def test_houseai_skips_unreadable_detail_and_keeps_its_total(monkeypatch, capsys, log_format):
    def respond(request):
        if str(request.url) == houseai.HUB_URL:
            return httpx.Response(200, text='<a href="/careers/test-listing">Open</a>')
        assert request.url.path == "/careers/test-listing"
        raise RuntimeError("synthetic private request detail")

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(houseai, "client", lambda: httpx.Client(transport=transport))

    assert houseai.fetch_houseai() == []
    captured = capsys.readouterr()
    assert captured.err == ""
    total = "[houseai] 0 student postings"
    if log_format is None:
        assert captured.out == total + "\n"
    else:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {
                "level": "WARNING",
                "message": "[houseai] job detail failed",
                "exception_type": "RuntimeError",
            },
            {"level": "INFO", "message": total},
        ]


def test_uhn_failure_keeps_its_diagnostic_and_return(monkeypatch, capsys, log_format):
    def respond(_request):
        raise RuntimeError("synthetic private request detail")

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(uhn, "client", lambda: httpx.Client(transport=transport))

    assert uhn.fetch_uhn() == []
    captured = capsys.readouterr()
    assert captured.err == ""
    message = "[uhn] failed: RuntimeError"
    if log_format is None:
        assert captured.out == message + "\n"
    else:
        assert json.loads(captured.out) == {
            "level": "WARNING",
            "message": message,
            "exception_type": "RuntimeError",
        }


def test_unavailable_json_console_does_not_interrupt_source_fallback(monkeypatch):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    monkeypatch.setattr(common, "_ROBOTS", {})

    def unavailable(*args, **kwargs):
        raise BrokenPipeError

    monkeypatch.setattr(common, "console", unavailable)
    with httpx.Client(transport=httpx.MockTransport(unavailable)) as client:
        assert common.robots_allows(client, "https://board.test", "/postings")
