"""scan_boards: which failures age a board toward MAX_FAILS, and which get a second try."""

import httpx
from datetime import datetime, timezone
from internscout import run_ingest
from internscout.discover import MAX_FAILS
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
            raise _status(404)  # not transient: no retry, and it ages
        return []

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 12)
    run_ingest.scan_boards(reg, workers=4, verbose=False)
    assert calls["t0"] == 1
    assert reg["fakeats"]["t0"]["fails"] == 1
    assert reg["fakeats"]["t1"]["fails"] == 0


def test_systemic_throttle_leaves_retry_budget_for_other_providers(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(run_ingest, "RETRY_MAX", 1)
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")

    def fetch(c, jobs, workers):
        calls.append([ats for ats, _, _ in jobs])
        return {(ats, token): _status(429) if len(calls) == 1 else [] for ats, token, _ in jobs}

    monkeypatch.setattr(run_ingest, "_fetch_boards", fetch)
    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "a-throttled", None)
    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "z-transient", None)
    reg = _reg("a-throttled", 12) | _reg("z-transient", 1)
    run_ingest.scan_boards(reg)

    assert calls[1:] == [["z-transient"]]
    assert all(entry["fails"] == 0 for entry in reg["a-throttled"].values())
    assert "::warning title=Listing provider rate limited::a-throttled: 12 of 12" in capsys.readouterr().out


def test_retry_after_only_allows_a_retry_within_the_existing_delay():
    now = datetime(2026, 11, 22, 16, 0, tzinfo=timezone.utc)
    error = _status(429)
    for value in ("120", "Sun, 22 Nov 2026 16:02:00 GMT", "invalid"):
        error.response.headers["Retry-After"] = value
        assert not run_ingest._can_retry_this_run(error, now)
    for value in ("10", "Sun, 22 Nov 2026 16:00:10 GMT"):
        error.response.headers["Retry-After"] = value
        assert run_ingest._can_retry_this_run(error, now)


def test_isolated_throttle_with_long_retry_after_does_not_age_the_board(monkeypatch):
    error = _status(429)
    error.response.headers["Retry-After"] = "120"
    calls = []

    def fetch(c, co):
        calls.append(co["ats_token"])
        raise error

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "isolated", fetch)
    reg = _reg("isolated", 1)
    run_ingest.scan_boards(reg, workers=1, verbose=False)
    assert calls == ["t0"]
    assert reg["isolated"]["t0"]["fails"] == 0


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
    # was: every board at fails == 1, to be asked again on three more days. A robots.txt "no" is
    # final for now, so the board is marked to go at this run's prune (and kept out after it).
    assert all(e["fails"] == MAX_FAILS and e["closed"] for e in reg["fakeats"].values())


def test_the_second_look_counts_dead_boards_but_not_throttled_ones(monkeypatch):
    # verify_registry's second pass: every board it is handed failed, so the guard must be off.
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)

    def fetch(c, co):
        raise _status(429 if co["ats_token"] == "t0" else 404)

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = _reg("fakeats", 12)
    run_ingest.scan_boards(reg, workers=4, verbose=False, systemic_guard=False)
    assert reg["fakeats"]["t0"]["fails"] == 0, "a throttle says nothing about the board"
    assert all(e["fails"] == 1 for t, e in reg["fakeats"].items() if t != "t0")


def test_cause_names_status_or_error_type():
    assert run_ingest._cause(_status(429)) == "429"
    assert run_ingest._cause(httpx.ReadTimeout("slow")) == "ReadTimeout"
    assert run_ingest._transient(_status(503)) and run_ingest._transient(httpx.ReadTimeout("x"))
    assert not run_ingest._transient(_status(404)) and not run_ingest._transient(ValueError())


def test_a_throttled_ats_runs_in_its_own_smaller_pool(monkeypatch):
    import threading, time

    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    monkeypatch.setitem(run_ingest.ATS_WORKERS, "slowats", 2)
    live, peak, lock = [0], [0], threading.Lock()

    def fetch(c, co):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        time.sleep(0.02)
        with lock:
            live[0] -= 1
        return []

    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "slowats", fetch)
    reg = _reg("slowats", 10)
    run_ingest.scan_boards(reg, workers=8, verbose=False)
    assert peak[0] <= 2
    assert all(e["fails"] == 0 for e in reg["slowats"].values())
