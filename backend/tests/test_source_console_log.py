import json

import httpx
import pytest
from internscout import console_log
from internscout.sources import (
    common,
    github_lists,
    greenhouse,
    houseai,
    lever,
    nyc_jobs,
    uhn,
    usajobs,
)


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


@pytest.mark.parametrize("output_error", [BrokenPipeError, RuntimeError])
def test_unavailable_json_console_does_not_interrupt_source_fallback(monkeypatch, output_error):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    monkeypatch.setattr(common, "_ROBOTS", {})
    attempted = []

    def unavailable(*args, **kwargs):
        attempted.append((args, kwargs))
        raise output_error

    requests = []

    def respond(request):
        requests.append(request.url.path)
        raise TimeoutError("synthetic private request detail")

    monkeypatch.setattr(console_log, "console", unavailable)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert common.robots_allows(client, "https://board.test", "/postings")
        assert common.robots_allows(client, "https://board.test", "/more")

    assert requests == ["/robots.txt"]
    assert len(attempted) == 1
    assert attempted[0][0] == ("[sources] robots lookup failed",)
    assert attempted[0][1]["exception_type"] == "TimeoutError"


@pytest.mark.parametrize(
    ("source", "fetch", "category"),
    [
        (github_lists, github_lists.fetch_github_lists, "list fetch failed"),
        (greenhouse, greenhouse.fetch_greenhouse, "board fetch failed"),
        (lever, lever.fetch_lever, "board fetch failed"),
        (nyc_jobs, nyc_jobs.fetch_nyc_jobs, "failed"),
        (usajobs, usajobs.fetch_usajobs, "failed"),
    ],
)
def test_source_failure_logs_only_safe_fields(
    monkeypatch, capsys, log_format, source, fetch, category
):
    requests = []
    if source is github_lists:
        args = (
            [
                {
                    "url": "https://provider.example.test/failing",
                    "source": "synthetic private list",
                },
                {"url": "https://provider.example.test/next", "source": "next", "cycle_years": {}},
            ],
        )
    elif source in (greenhouse, lever):
        args = (
            [
                {"name": "synthetic private board", "ats_token": "synthetic-private-board"},
                {"name": "next", "ats_token": "next"},
            ],
        )
    elif source is usajobs:
        args = ("synthetic-key", "synthetic@example.test")
    else:
        args = ()
    single_request = source in (nyc_jobs, usajobs)

    def respond(request):
        requests.append(request.url.path)
        if len(requests) == 1:
            raise RuntimeError("synthetic private provider detail")
        assert not single_request and len(requests) == 2
        payload = {"jobs": [], "meta": {"total": 0}} if source is greenhouse else []
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(source, "client", lambda: httpx.Client(transport=transport))
    assert fetch(*args) == []
    assert len(requests) == (1 if single_request else 2)
    captured = capsys.readouterr()
    assert captured.err == ""
    name = source.__name__.rsplit(".", 1)[-1]
    error = f"[{name}] {category}: RuntimeError"
    messages = [{"level": "WARNING", "message": error, "exception_type": "RuntimeError"}]
    if source is usajobs:
        messages.append({"level": "INFO", "message": f"[{name}] 0 student postings"})
    if log_format is None:
        assert captured.out == "".join(line["message"] + "\n" for line in messages)
    else:
        assert [json.loads(line) for line in captured.out.splitlines()] == messages
