"""scan_boards: which failures age a board toward MAX_FAILS, and which get a second try."""
import httpx
from internscout import run_ingest
from internscout.sources.common import RobotsDisallowed


def _status(code):
    req = httpx.Request("GET", "https://example.test/")
    return httpx.HTTPStatusError(str(code), request=req, response=httpx.Response(code, request=req))


def _reg(ats, n):
    return {ats: {f"t{i}": {"name": f"Co {i}", "fails": 0} for i in range(n)}}


def test_transient_failure_is_retried_and_counts_as_success(monkeypatch):
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    calls = {}

    def fetch(c, co):
        tok = co["ats_token"]
        calls[tok] = calls.get(tok, 0) + 1
        if tok == "t0" and calls[tok] == 1:
            raise _status(429)
        return [{"title": f"Intern {tok}"}]

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 3)
    out = run_ingest.scan_boards(reg, workers=2, verbose=False)
    assert calls["t0"] == 2 and calls["t1"] == 1
    assert len(out) == 3
    assert all(e["fails"] == 0 for e in reg["fakeats"].values())


def test_a_dead_board_still_ages(monkeypatch):
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    calls = {}

    def fetch(c, co):
        tok = co["ats_token"]
        calls[tok] = calls.get(tok, 0) + 1
        if tok == "t0":
            raise _status(404)   # not transient: no retry, and it ages
        return []

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 12)
    run_ingest.scan_boards(reg, workers=4, verbose=False)
    assert calls["t0"] == 1
    assert reg["fakeats"]["t0"]["fails"] == 1
    assert reg["fakeats"]["t1"]["fails"] == 0


def test_an_ats_failing_on_most_boards_does_not_age_them(monkeypatch):
    """Workable failed 61 of 61 in CI while answering 200 from a laptop: that is a block, not 61 deaths."""
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)

    def fetch(c, co):
        if co["ats_token"] in ("t0", "t1"):
            return []
        raise _status(403)

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 12)
    run_ingest.scan_boards(reg, workers=4, verbose=False)
    assert all(e["fails"] == 0 for e in reg["fakeats"].values())


def test_robots_closed_boards_age_even_when_the_ats_is_systemic(monkeypatch):
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)

    def fetch(c, co):
        raise RobotsDisallowed(co["ats_token"])

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 12)
    run_ingest.scan_boards(reg, workers=4, verbose=False)
    assert all(e["fails"] == 1 for e in reg["fakeats"].values())


def test_cause_names_status_or_error_type():
    assert run_ingest._cause(_status(429)) == "429"
    assert run_ingest._cause(httpx.ReadTimeout("slow")) == "ReadTimeout"
    assert run_ingest._transient(_status(503)) and run_ingest._transient(httpx.ReadTimeout("x"))
    assert not run_ingest._transient(_status(404)) and not run_ingest._transient(ValueError())
