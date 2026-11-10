import io
import json
import logging
import sys

import httpx
import pytest
from internscout.console_log import console
from internscout.sources import google_jobs


def test_default_output_uses_print_options_and_the_current_stream(monkeypatch, capsys, caplog):
    monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    caplog.set_level(logging.INFO)

    class FlushCounter(io.StringIO):
        count = 0

        def flush(self):
            self.count += 1
            super().flush()

    stream = FlushCounter()
    console("plain", 2)
    console("error", 3, sep=":", end="", file=sys.stderr)
    console()
    console("custom", None, sep="/", end="!", file=stream, flush=True)

    captured = capsys.readouterr()
    assert captured.out == "plain 2\n\n"
    assert captured.err == "error:3"
    assert stream.getvalue() == "custom/None!"
    assert stream.count == 1
    assert caplog.records == []


def test_global_logging_settings_cannot_suppress_console(monkeypatch, capsys):
    monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    previous = logging.root.manager.disable
    factory = logging.getLogRecordFactory()

    def unexpected_factory(*args, **kwargs):
        raise AssertionError("console diagnostic used the global logging factory")

    console("before")
    try:
        logging.disable(logging.CRITICAL)
        logging.setLogRecordFactory(unexpected_factory)
        console("cached info")
        console("first error", level=logging.ERROR)
    finally:
        logging.setLogRecordFactory(factory)
        logging.disable(previous)
    console("after", level=logging.ERROR)

    assert capsys.readouterr().out == "before\ncached info\nfirst error\nafter\n"


def test_json_is_one_record_even_for_multiline_text(monkeypatch, capsys):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    console('quote "\nnewline', "café", sep=" / ", end="", file=sys.stderr)

    captured = capsys.readouterr()
    assert captured.out == ""
    assert len(captured.err.splitlines()) == 1
    assert json.loads(captured.err) == {
        "level": "INFO",
        "message": 'quote "\nnewline / café',
    }


@pytest.mark.parametrize("log_format", [None, "json"])
def test_google_jobs_logs_caught_exception_types_without_their_messages(
    monkeypatch, capsys, log_format
):
    if log_format is None:
        monkeypatch.delenv("INTERNSCOUT_LOG_FORMAT", raising=False)
    else:
        monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", log_format)
    monkeypatch.setenv("SERPAPI_MONTHLY_SEARCHES", "100")
    requests = []

    def respond(request):
        requests.append(request.url.path)
        if request.url.path == "/account.json":
            raise RuntimeError("private account error")
        raise ValueError("private search error")

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(google_jobs, "client", lambda: httpx.Client(transport=transport))

    assert (
        google_jobs.fetch_google_jobs(
            ["design intern"], ["Boston, Massachusetts"], api_key="mock", max_searches=3
        )
        == []
    )
    assert requests == ["/account.json", "/search.json"]

    captured = capsys.readouterr()
    assert captured.err == ""
    expected = [
        "[google_jobs] account check failed (RuntimeError); assuming the free plan",
        "[google_jobs] budget today 3 (searches left this month: unknown)",
        "[google_jobs] 0 top-50 metro, 0 daily, 0 focus search(es), then "
        "1 quer(ies) x 1 location(s) (cap 3)",
        "[google_jobs] 'design intern' @ Boston, Massachusetts failed: ValueError",
    ]
    if log_format is None:
        assert captured.out == "\n".join(expected) + "\n"
    else:
        assert [json.loads(line) for line in captured.out.splitlines()] == [
            {"level": "WARNING", "message": expected[0], "exception_type": "RuntimeError"},
            {"level": "INFO", "message": expected[1]},
            {"level": "INFO", "message": expected[2]},
            {"level": "WARNING", "message": expected[3], "exception_type": "ValueError"},
        ]
