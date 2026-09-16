import httpx
from internscout.sources import google_jobs as gj


def test_budget_spreads_the_month_and_never_exceeds_what_is_left():
    assert gj.daily_budget({"searches_per_month": 250, "total_searches_left": 200}, 12) == 8
    assert gj.daily_budget({"searches_per_month": 100, "total_searches_left": 90}, 12) == 3
    assert gj.daily_budget({"searches_per_month": 250, "total_searches_left": 2}, 12) == 2
    assert gj.daily_budget({"searches_per_month": 250, "total_searches_left": 0}, 12) == 0
    assert gj.daily_budget({"searches_per_month": 5000, "total_searches_left": 4000}, 12) == 12
    # account check failed: assume the smallest plan rather than the old 12-per-run
    assert gj.daily_budget(None, 12) == 3


def test_only_the_first_run_of_the_day_searches():
    assert gj.is_daily_run(0) and gj.is_daily_run(2)
    assert not gj.is_daily_run(6) and not gj.is_daily_run(10) and not gj.is_daily_run(23)


def _patch(monkeypatch, handler, hour=2):
    real = httpx.Client
    monkeypatch.setattr(gj, "client", lambda: real(transport=httpx.MockTransport(handler)))

    monkeypatch.setattr(gj, "is_daily_run", lambda h: hour < 6)
    monkeypatch.setenv("SERPAPI_KEY", "test")
    monkeypatch.delenv("SERPAPI_EVERY_RUN", raising=False)


def test_a_429_stops_the_run_instead_of_burning_through_every_search(monkeypatch, capsys):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 250, "total_searches_left": 100})
        return httpx.Response(429, json={"error": "out"})
    _patch(monkeypatch, handler)
    assert gj.fetch_google_jobs(["q1", "q2"], ["Boston, Massachusetts", "New York, New York"]) == []
    assert calls == ["/account.json", "/search.json"]
    out = capsys.readouterr().out
    assert "api_key" not in out and "test" not in out


def test_later_runs_in_the_day_spend_nothing(monkeypatch):
    calls = []
    _patch(monkeypatch, lambda req: calls.append(req) or httpx.Response(500), hour=10)
    assert gj.fetch_google_jobs(["q1"], ["Boston, Massachusetts"]) == []
    assert calls == []


def test_budget_caps_searches_and_results_are_parsed(monkeypatch):
    searches = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 100, "total_searches_left": 50})
        searches.append(req.url.params["location"])
        return httpx.Response(200, json={"jobs_results": [
            {"company_name": "MFA", "title": "Museum Intern " + req.url.params["location"],
             "location": req.url.params["location"], "apply_options": [{"link": "https://x.test/1"}]}]})
    _patch(monkeypatch, handler)
    locs = ["Boston, Massachusetts", "New York, New York", "Hartford, Connecticut",
            "Providence, Rhode Island", "Manchester, New Hampshire", "Portland, Maine"]
    items = gj.fetch_google_jobs(["museum internship", "arts internship"], locs)
    assert len(searches) == 3                       # 100 / 31
    assert len(items) == 3 and items[0]["source"] == "google_jobs" and items[0]["apply_url"] == "https://x.test/1"
