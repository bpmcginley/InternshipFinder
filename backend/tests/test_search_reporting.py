"""Search comparisons must not mistake incomplete dates or other engines for Google recovery."""
import importlib.util
import json
import io
import urllib.error
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("reporting_metrics", ROOT / "growth" / "metrics.py")
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)
NOW = datetime(2026, 10, 28, 17, tzinfo=timezone.utc)


@pytest.mark.parametrize("host,engine", [("www.google.com", "google"), ("google.ca", "google"),
    ("www.google.co.uk", "google"), ("www.google.com.hk", "google"), ("www.bing.com", "bing"),
    ("cn.bing.com", "bing"), ("duckduckgo.com", "other_search"), ("chatgpt.com", "other_search")])
def test_search_engines_are_separate(host, engine):
    assert metrics.source(host) == "search"
    assert metrics.search_engine(host) == engine


@pytest.mark.parametrize("host", ["mail.google.com", "accounts.google.com", "mail.google.co.uk",
    "accounts.google.ca", "maps.google.co.in", "google.com.evil.example", "notgoogle.com",
    "google.evil.com", "notinternscout.org"])
def test_mail_auth_and_false_domain_suffixes_are_not_search_or_direct(host):
    assert metrics.source(host) == "other"
    assert metrics.search_engine(host) is None


def cf_reply(**changes):
    acct = {key: [] for key in ("days", "landing", "refs", "pages", "topRefs", "countries")}
    acct.update(changes)
    return {"data": {"viewer": {"accounts": [acct]}}}


def test_successful_omitted_cloudflare_day_replaces_stale_estimate_and_labels_sampling(monkeypatch):
    refs = [{"dimensions": {"date": "2026-10-26", "refererHost": host}, "sum": {"visits": n}}
            for host, n in [("www.google.com", 2), ("www.bing.com", 10), ("duckduckgo.com", 3),
                            ("accounts.google.com", 7)]]
    monkeypatch.setattr(metrics, "_json", lambda *a, **k: cf_reply(
        days=[{"dimensions": {"date": "2026-10-26"}, "sum": {"visits": 20}}], refs=refs))
    rows, week = metrics.visits("synthetic", NOW)
    by_day = {r["day"]: r for r in rows}
    assert len(rows) == 30
    assert by_day["2026-10-25"]["visits"] == 0
    assert "2026-10-25" in week["coverage"]["omitted_days"]
    assert "not proof" in week["coverage"]["omitted_day_value"]
    assert week["coverage"]["measurement"] == "adaptive_sample_estimates"
    assert by_day["2026-10-26"]["search"] == 15
    assert next(d for d in week["search_engines"]["days"] if d["day"] == "2026-10-26") == {
        "day": "2026-10-26", "google": 2, "bing": 10, "other_search": 3}


@pytest.mark.parametrize("reply", [None, {"errors": [{"message": "unavailable"}]}, cf_reply(days=None),
                                   {"data": {"viewer": {"accounts": []}}},
                                   {"data": {"viewer": {"accounts": [None]}}}])
def test_failed_or_incomplete_cloudflare_response_never_becomes_zero_visits(monkeypatch, reply):
    monkeypatch.setattr(metrics, "_json", lambda *a, **k: reply)
    with pytest.raises((RuntimeError, IndexError)):
        metrics.visits("synthetic", NOW)


def test_cloudflare_failed_collection_does_not_overwrite_stored_daily_values(monkeypatch, capsys):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "synthetic")
    monkeypatch.setattr(metrics, "visits", lambda *a: (_ for _ in ()).throw(RuntimeError("unavailable")))
    for name in ("bluesky", "instagram", "mastodon", "automation", "search_console", "bing", "listings", "page_count", "store"):
        monkeypatch.setattr(metrics, name, lambda *a: {})
    monkeypatch.setattr(metrics, "automation", lambda *a: [])
    calls = []
    monkeypatch.setattr(metrics, "d1", lambda token, sql, params: calls.append(sql))
    assert metrics.main(["metrics.py", "--write"]) == 0
    assert not any("INSERT OR REPLACE INTO metrics_daily" in sql for sql in calls)
    assert "unavailable" in capsys.readouterr().out


def stub_google(monkeypatch, metadata=None, final_rows=None, fail_week=False):
    monkeypatch.setenv("GSC_SERVICE_ACCOUNT", json.dumps({"client_email": "synthetic", "private_key": "synthetic"}))
    monkeypatch.setattr(metrics, "_gsc_token", lambda _: "synthetic")
    calls = []
    def answer(url, body=None, token=None, **kwargs):
        if "urlInspection" in url:
            return {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "lastCrawlTime": "2026-10-28T12:00:00Z"}}}
        calls.append(body)
        if body["dataState"] == "all":
            return {"metadata": metadata or {}, "rows": [{"keys": ["2026-10-28"], "clicks": 99, "impressions": 9999}]}
        if body["dimensions"] == ["date", "page"]:
            return {"rows": [{"keys": [body["startDate"], "https://internscout.org/internships/at/bose/"],
                              "clicks": 1, "impressions": 10, "position": 8.1}]}
        if body["dimensions"] == ["date"]:
            return {"rows": final_rows or [], "responseAggregationType": "byProperty"}
        if fail_week and body["rowLimit"] == metrics.GSC_WEEK_PAGES:
            raise RuntimeError("detail temporarily unavailable")
        key = "https://internscout.org/internships/software-engineering/" if body["dimensions"] == ["page"] else "synthetic private query"
        return {"rows": [{"keys": [key], "clicks": 1, "impressions": 10, "position": 8.1}],
                "responseAggregationType": "byPage" if body["dimensions"] == ["page"] else "byProperty"}
    monkeypatch.setattr(metrics, "_json", answer)
    return calls


def test_final_google_windows_use_pacific_metadata_and_keep_zero_final_day(monkeypatch):
    calls = stub_google(monkeypatch, {"first_incomplete_date": "2026-10-27"},
        [{"keys": ["2026-10-25"], "clicks": 2, "impressions": 20, "position": 9}])
    got = metrics.search_console(NOW)
    assert got["reporting"]["end"] == "2026-10-26"  # zero-impression final day does not shift the end
    assert got["reporting"]["seven_day_start"] == "2026-10-20"
    assert got["reporting"]["timezone"] == "America/Los_Angeles"
    assert got["reporting"]["completeness_metadata"] == {"first_incomplete_date": "2026-10-27"}
    assert got["totals_7d"]["clicks"] == 2
    assert got["totals_28d"]["impressions"] == 20  # preliminary probe never contaminates totals
    assert all(c["dataState"] == "final" and c["type"] == "web" for c in calls[1:])
    assert [(w["start"], w["end"]) for w in got["comparison"]["weeks"]] == [
        ("2026-10-12", "2026-10-18"), ("2026-10-19", "2026-10-25")]
    assert got["pages"][0]["url"].startswith("https://internscout.org/")
    assert got["reporting"]["limits"]["queries"]["exhaustive"] is False
    assert len(calls) == 9


def test_metadata_absent_uses_explicit_lag_not_latest_nonzero_date(monkeypatch):
    calls = stub_google(monkeypatch, final_rows=[{"keys": ["2026-10-20"], "clicks": 1, "impressions": 5}])
    got = metrics.search_console(datetime(2026, 10, 28, 1, tzinfo=timezone.utc))
    assert calls[0]["endDate"] == "2026-10-27"  # still Oct 27 Pacific
    assert got["reporting"]["end"] == "2026-10-24"
    assert got["reporting"]["boundary_basis"] == "conservative_three_day_lag_metadata_unavailable"


def test_optional_cohort_failure_preserves_final_headlines_and_does_not_invent_empty_details(monkeypatch):
    stub_google(monkeypatch, {"first_incomplete_date": "2026-10-27"},
                [{"keys": ["2026-10-25"], "clicks": 2, "impressions": 20}], fail_week=True)
    got = metrics.search_console(NOW)
    assert got["totals_7d"]["clicks"] == 2
    assert all(w["status"] == "unavailable" and "pages" not in w and "queries" not in w
               for w in got["comparison"]["weeks"])


def test_private_weekly_queries_and_full_urls_do_not_leak_into_public_logs(monkeypatch):
    stub_google(monkeypatch, {"first_incomplete_date": "2026-10-27"})
    snap = {"search_console": metrics.search_console(NOW)}
    original = json.dumps(snap)
    shown = json.dumps(metrics.printable(snap))
    assert "synthetic private query" not in shown
    assert "https://internscout.org/internships/software-engineering/" not in shown
    assert json.dumps(snap) == original


def test_capped_diagnostics_are_explicitly_non_exhaustive(monkeypatch):
    monkeypatch.setattr(metrics, "_gsc_response", lambda *a: {"rows": [
        {"keys": ["private"], "impressions": 5}, {"keys": ["private2"], "impressions": 2}]})
    _, limits = metrics._gsc_details("synthetic", {}, "query", 2)
    assert limits["at_row_limit"] and not limits["exhaustive"]


def test_fixed_page_date_cohort_has_exact_eight_urls_and_both_complete_weeks(monkeypatch):
    calls = stub_google(monkeypatch, {"first_incomplete_date": "2026-10-27"})
    got = metrics.search_console(NOW)
    cohort = got["fixed_page_cohort"]
    request = next(c for c in calls if c["dimensions"] == ["date", "page"])
    assert request["startDate"] == "2026-10-12" and request["endDate"] == "2026-10-25"
    assert request["dataState"] == "final" and request["rowLimit"] == 1000
    regex = re.compile(request["dimensionFilterGroups"][0]["filters"][0]["expression"])
    for slug in ("under-armour", "medtronic", "lyft", "bose", "shure", "sun-life", "ul-solutions", "capital-one"):
        assert regex.fullmatch(f"https://internscout.org/internships/at/{slug}/")
    for url in ("https://evil.example/internships/at/bose/", "https://internscout.org/internships/at/bose/extra/",
                "https://internscout.org/internships/at/bose/?email=private", "http://internscout.org/internships/at/bose/"):
        assert not regex.fullmatch(url)
    assert cohort["status"] == "available" and cohort["max_possible_page_days"] == 112
    assert cohort["rows"][0]["url"] == "https://internscout.org/internships/at/bose/"
    assert "https://internscout.org/internships/at/bose/" not in json.dumps(metrics.printable({"search_console": got}))


def test_fixed_cohort_failure_does_not_erase_successful_headlines(monkeypatch):
    stub_google(monkeypatch, {"first_incomplete_date": "2026-10-27"},
                [{"keys": ["2026-10-25"], "clicks": 2, "impressions": 20}])
    answer = metrics._gsc_response
    def fail(token, body):
        if body["dimensions"] == ["date", "page"]:
            raise RuntimeError("optional query unavailable")
        return answer(token, body)
    monkeypatch.setattr(metrics, "_gsc_response", fail)
    got = metrics.search_console(NOW)
    assert got["totals_7d"]["clicks"] == 2
    assert got["fixed_page_cohort"]["status"] == "unavailable" and "rows" not in got["fixed_page_cohort"]


def test_cloudflare_matched_pacific_weeks_account_for_dst_and_do_not_mix_engines(monkeypatch):
    calls = []
    def answer(url, body=None, token=None):
        calls.append(body)
        return cf_reply(refs=[{"dimensions": {"refererHost": h}, "sum": {"visits": n}}
                              for h, n in [("www.google.com", 4), ("www.bing.com", 20), ("mail.google.co.uk", 9)]])
    monkeypatch.setattr(metrics, "_json", answer)
    got = metrics.cloudflare_search_comparison("synthetic", [
        {"start": "2026-10-26", "end": "2026-11-01"}, {"start": "2026-11-02", "end": "2026-11-08"}])
    assert calls[0]["variables"]["start"] == "2026-10-26T07:00:00Z"
    assert calls[0]["variables"]["end"] == "2026-11-02T08:00:00Z"  # DST week has 169 hours
    assert calls[1]["variables"]["start"] == "2026-11-02T08:00:00Z"
    assert got["weeks"][0]["visits"] == {"google": 4, "bing": 20, "other_search": 0}
    assert got["measurement"] == "adaptive_sample_estimates"


def test_optional_inspection_reads_crawl_state_without_requesting_indexing(monkeypatch):
    calls = []
    def answer(url, body, token, timeout):
        calls.append((url, body, token, timeout))
        return {"inspectionResult": {"indexStatusResult": {"lastCrawlTime": "2026-10-28T12:00:00Z",
            "coverageState": "Submitted and indexed", "verdict": "PASS", "googleCanonical": body["inspectionUrl"],
            "userCanonical": body["inspectionUrl"], "indexingState": "INDEXING_ALLOWED", "pageFetchState": "SUCCESSFUL"}}}
    monkeypatch.setattr(metrics, "_json", answer)
    got = metrics.inspect_search_pages("synthetic", NOW)
    assert len(calls) == 4 and all(c[0].endswith("urlInspection/index:inspect") and c[3] == 10 for c in calls)
    assert all(c[1]["siteUrl"] == metrics.GSC_SITE for c in calls)
    assert got["checked_at"] == "2026-10-28T17:00:00Z"
    assert got["results"][0]["lastCrawlTime"] == "2026-10-28T12:00:00Z"
    assert got["results"][0]["verdict"] == "PASS"


def test_inspection_stops_at_first_permission_denial_without_losing_main_report(monkeypatch):
    calls = []
    def denied(*args, **kwargs):
        calls.append(args)
        raise urllib.error.HTTPError("https://searchconsole.googleapis.com/", 403, "denied", {}, io.BytesIO(b""))
    monkeypatch.setattr(metrics, "_json", denied)
    got = metrics.inspect_search_pages("synthetic", NOW)
    assert len(calls) == 1 and got["status"] == "unavailable"
    assert got["results"][0]["error"] == "HTTP 403"
