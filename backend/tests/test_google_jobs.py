from datetime import datetime, timezone

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


# was: test_only_the_first_run_of_the_day_searches, on is_daily_run(hour): hour < 6
def test_only_the_first_run_of_the_day_searches_whatever_the_hour():
    assert gj.is_daily_run("2026-09-30")            # nothing recorded yet
    gj.mark_searched("2026-09-30")
    assert not gj.is_daily_run("2026-09-30")        # a later run the same UTC day
    assert gj.is_daily_run("2026-10-01")            # the next day's first run, at any hour


def _patch(monkeypatch, handler, hour=2):
    real = httpx.Client
    monkeypatch.setattr(gj, "client", lambda: real(transport=httpx.MockTransport(handler)))
    # was: monkeypatch.setattr(gj, "is_daily_run", lambda h: hour < 6). "A later run" is now one that
    # finds today already recorded.
    if hour >= 6:
        monkeypatch.setattr(gj, "is_daily_run", lambda today: False)
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


def test_focus_searches_run_first_and_come_out_of_the_same_budget(monkeypatch):
    searches = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 250, "total_searches_left": 200})
        searches.append((req.url.params["q"], req.url.params["location"]))
        return httpx.Response(200, json={"jobs_results": []})
    _patch(monkeypatch, handler)
    locs = ["Boston, Massachusetts", "New York, New York", "Hartford, Connecticut", "Providence, Rhode Island",
            "Manchester, New Hampshire", "Portland, Maine"]
    gj.fetch_google_jobs(["museum internship"], locs, focus_queries=["psychology internship", "economics internship"],
                         focus_searches=2)
    assert len(searches) == 8                       # 250 / 31: the focus pair does not add to it
    assert {q for q, _ in searches[:2]} == {"psychology internship", "economics internship"}
    assert searches[0][1] != searches[1][1]         # each focus search on a different metro
    assert all(q == "museum internship" for q, _ in searches[2:])


def test_a_search_that_times_out_is_asked_once_more_and_the_day_is_recorded(monkeypatch, capsys):
    tries = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 100, "total_searches_left": 50})
        tries.append(req.url.params["location"])
        if len(tries) == 1:
            raise httpx.ReadTimeout("slow", request=req)
        return httpx.Response(200, json={"jobs_results": [
            {"company_name": "MFA", "title": "Museum Intern", "apply_options": [{"link": "https://x.test/1"}]}]})
    _patch(monkeypatch, handler)
    items = gj.fetch_google_jobs(["museum internship"], ["Boston, Massachusetts"])
    assert tries == ["Boston, Massachusetts", "Boston, Massachusetts"]
    assert [i["company_name"] for i in items] == ["MFA"]
    assert "timed out; asking once more" in capsys.readouterr().out
    assert not gj.is_daily_run(datetime.now(timezone.utc).date().isoformat())   # recorded before searching



def test_the_daily_searches_run_first_every_day_out_of_the_same_budget(monkeypatch):
    searches = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 250, "total_searches_left": 200})
        searches.append((req.url.params["q"], req.url.params["location"]))
        return httpx.Response(200, json={"jobs_results": []})
    _patch(monkeypatch, handler)
    gj.fetch_google_jobs(["museum internship"], ["Boston, Massachusetts", "New York, New York"],
                         fixed=[("Ontario Public Service student job", "Toronto, Ontario, Canada")])
    assert searches[0] == ("Ontario Public Service student job", "Toronto, Ontario, Canada")
    assert len(searches) == 3                       # the daily one, then one query in each of two places


def test_the_daily_searches_never_go_past_the_budget(monkeypatch):
    searches = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 31, "total_searches_left": 30})
        searches.append(req.url.params["q"])
        return httpx.Response(200, json={"jobs_results": []})
    _patch(monkeypatch, handler)
    gj.fetch_google_jobs(["museum internship"], ["Boston, Massachusetts"], fixed=[("a", "X"), ("b", "Y")])
    assert searches == ["a"]                        # a budget of one: the first daily search, and nothing else


def test_canada_gets_a_metro_a_day_and_every_pair_in_turn():
    from internscout.config import GOOGLE_JOBS_CANADA_LOCATIONS as places, GOOGLE_JOBS_CANADA_QUERIES as queries
    from internscout.config import canada_searches
    start = 739000
    week = [canada_searches(start + d)[0][1] for d in range(len(places))]
    assert sorted(week) == sorted(places)                       # each metro once every six days
    pairs = {canada_searches(start + d)[0] for d in range(len(places) * len(queries))}
    assert len(pairs) == len(places) * len(queries)             # every pair within 36 days
    assert canada_searches(start, n=0) == []


def test_a_canadian_search_asks_for_canadian_results(monkeypatch):
    seen = []

    def handler(req):
        if req.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 250, "total_searches_left": 200})
        seen.append((req.url.params["location"], req.url.params.get("gl")))
        return httpx.Response(200, json={"jobs_results": []})
    _patch(monkeypatch, handler)
    gj.fetch_google_jobs(["museum internship"], ["Boston, Massachusetts"],
                         fixed=[("co-op student 2027", "Toronto, Ontario, Canada")])
    assert seen[0] == ("Toronto, Ontario, Canada", "ca")
    assert ("Boston, Massachusetts", None) in seen
