"""Page-boundary counts and whole-source outcomes in the ingest report. Offline fixtures only.

Every board adapter reports what it saw before the pipeline: what the API said it listed (when it
says), the rows it read, the rows it discarded and why, and whether a cap stopped it. Non-board
sources report a whole-source outcome. A measurement that was not made stays out of the report.
"""
import json
import sys
from unittest.mock import Mock

import httpx
import pytest

from internscout import run_ingest
from internscout.ingest_metrics import IngestMetrics
from internscout.sources import common, github_lists, google_jobs, icims_site, nyc_jobs, uhn, usajobs
from internscout.sources.common import ScanCounts, counts_of, report_source
from internscout.sources.jazzhr import parse_jazzhr
from internscout.sources.jobvite import parse_jobvite

from test_scan_completeness import ADAPTERS, NOISE, scan

API_ADAPTERS = list(ADAPTERS)   # every adapter whose API can report a total
UNPAGED = {"workable", "bamboohr", "rippling"}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    common._ROBOTS.clear()
    monkeypatch.setattr(icims_site, "CRAWL_DELAY", 0)
    yield
    common._ROBOTS.clear()


def balanced(counts: dict, returned: int) -> bool:
    return counts["read"] == returned + sum(counts["discarded"].values())


# ------------------------------------------------------------------ board adapters, by group

@pytest.mark.parametrize("ats", API_ADAPTERS)
def test_api_adapters_report_discovered_read_and_discarded(ats):
    result, _ = scan(ats, ["Software Engineer Intern", "Data Science Intern", NOISE, NOISE])
    counts = result.counts.as_dict()
    assert len(result) == 2
    assert counts["discovered"] == 4 and counts["read"] == 4
    assert counts["discarded"] == {"not_student": 2}
    assert counts["capped"] is False and balanced(counts, len(result))


@pytest.mark.parametrize("ats", API_ADAPTERS)
def test_an_empty_board_is_measured_as_zero_not_left_unknown(ats):
    result, _ = scan(ats, [])
    counts = result.counts.as_dict()
    assert counts["discovered"] == 0 and counts["read"] == 0 and counts["discarded"] == {}


@pytest.mark.parametrize("ats,stops", [
    ("workday", {"dry_pages": 1}), ("oracle", {"page_cap": 1}), ("smartrecruiters", {"page_cap": 1}),
    ("taleo", {"page_cap": 1}), ("eightfold", {"page_cap": 1}), ("icims_site", {"page_cap": 1}),
    ("adp", {"page_cap": 1}),
])
def test_a_cap_is_reported_and_leaves_discovered_above_read(ats, stops):
    result, _ = scan(ats, ["Software Engineer Intern"], "capped")
    counts = result.counts.as_dict()
    assert counts["capped"] is True and counts["stops"] == stops
    assert counts["discovered"] > counts["read"] >= len(result) == 1
    assert balanced(counts, len(result))


def test_a_list_that_does_not_add_up_shows_as_discovered_above_read():
    # BambooHR's capped fixture states 500 more openings than its list holds: not a cap, a gap.
    result, _ = scan("bamboohr", ["Software Engineer Intern"], "capped")
    counts = result.counts.as_dict()
    assert counts["capped"] is False and counts["discovered"] == counts["read"] + 500


@pytest.mark.parametrize("ats", ["workday", "oracle", "taleo", "eightfold", "icims_site", "adp"])
def test_a_missing_total_leaves_discovered_unmeasured(ats):
    result, _ = scan(ats, ["Software Engineer Intern"], "malformed")
    assert "discovered" not in result.counts.as_dict()


def test_a_total_without_its_rows_shows_the_gap():
    # SmartRecruiters' malformed fixture keeps totalFound and drops the rows list.
    result, _ = scan("smartrecruiters", ["Software Engineer Intern"], "malformed")
    counts = result.counts.as_dict()
    assert counts["discovered"] == 1 and counts["read"] == 0 and result.complete is False


def test_rippling_location_rows_of_one_job_count_as_duplicates():
    rows = [{"uuid": "u1", "name": "Data Intern", "url": "https://ats.rippling.com/acme/jobs/u1",
             "workLocation": {"label": label}} for label in ("Boston, MA", "Austin, TX")]
    co = {"name": "Acme", "ats_token": "acme", "sector": None, "location": None}
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(
            200, json=rows) if r.url.path.endswith("/jobs") else httpx.Response(404))) as c:
        result = run_ingest._fetch_board(c, "rippling", co)
    counts = result.counts.as_dict()
    assert len(result) == 1 and counts["read"] == 2 and counts["discarded"] == {"duplicate": 1}


def test_workday_overlap_between_searches_is_counted_once_as_a_duplicate(monkeypatch):
    monkeypatch.setenv("WORKDAY_EXTRA_KEYWORDS", "co-op")
    by_kw = {"intern": ["Software Engineer Intern", NOISE],
             "co-op": ["Software Engineer Intern", "Mechanical Co-op"]}

    def handle(request):
        if request.method != "POST":
            return httpx.Response(404)
        body = json.loads(request.content)
        rows = by_kw[body["searchText"]][body["offset"]:body["offset"] + body["limit"]]
        return httpx.Response(200, json={"total": len(by_kw[body["searchText"]]), "jobPostings": [
            {"title": t, "externalPath": "/job/" + t.replace(" ", "-"), "locationsText": "Boston, MA"}
            for t in rows]})

    co = {"name": "Acme", "ats_token": "acme|wd1|Careers", "sector": None, "location": None}
    with httpx.Client(transport=httpx.MockTransport(handle)) as c:
        result = run_ingest._fetch_board(c, "workday", co)
    counts = result.counts.as_dict()
    assert len(result) == 2
    assert counts == {"discovered": 4, "read": 4, "capped": False,
                      "discarded": {"not_student": 1, "duplicate": 1}}


def test_region_discards_are_their_own_reason():
    co = {"name": "Acme", "ats_token": "acme", "_counts": ScanCounts()}
    from internscout.sources.smartrecruiters import parse_smartrecruiters
    parse_smartrecruiters({"content": [
        {"id": "1", "name": "Data Intern", "location": {"city": "Boston", "region": "MA", "country": "us"}},
        {"id": "2", "name": "Data Intern", "location": {"city": "Paris", "country": "fr"}},
        {"id": "3", "name": "Accountant", "location": {"city": "Boston", "country": "us"}}]}, co, "acme")
    assert co["_counts"].discarded == {"outside_region": 1, "not_student": 1}


# HTML adapters have no result total: read is measured, discovered never is.

def _html_board(ats, body, token="acme"):
    co = {"name": "Acme", "ats_token": token, "sector": None, "location": None}
    handle = lambda request: (httpx.Response(404) if request.url.path.endswith("robots.txt")
                              or "/job/" in request.url.path or "/jobs/7" in request.url.path
                              else httpx.Response(200, text=body))
    with httpx.Client(transport=httpx.MockTransport(handle)) as c:
        return run_ingest._fetch_board(c, ats, co)


def test_jobvite_counts_rows_but_never_a_total():
    page = ('<td class="jv-job-list-name"><a href="/acme/job/a1">Summer Intern</a></td>'
            '<td class="jv-job-list-location">Boston, MA</td>'
            '<td class="jv-job-list-name"><a href="/acme/job/b2">Agency Attorney</a></td>'
            '<td class="jv-job-list-location">Boston, MA</td>')
    result = _html_board("jobvite", page)
    assert result.counts.as_dict() == {"read": 2, "discarded": {"not_student": 1}, "capped": False}


def test_jazzhr_counts_unreadable_entries_and_repeats():
    def item(slug, title):
        return (f'<li class="list-group-item"><a href="https://acme.applytojob.com/apply/{slug}/x" >'
                f'{title}</a></li>')
    page = (item("a1", "Engineering Intern") + item("a1", "Engineering Intern")
            + item("a2", "Account Director") + '<li class="list-group-item">no link here</li>')
    co = {"name": "Acme", "ats_token": "acme", "_counts": ScanCounts()}
    assert len(parse_jazzhr(page, co)) == 1
    counts = co["_counts"].as_dict()
    assert counts["read"] == 4 and "discovered" not in counts
    assert counts["discarded"] == {"duplicate": 1, "not_student": 1, "unreadable": 1}


def test_icims_portal_counts_cards_and_cross_keyword_repeats():
    card = ('<li class="iCIMS_JobCardItem"><span class="field-label">Job Locations</span>'
            '<span>US-MA-Boston</span><a href="https://acme.icims.com/jobs/7600/x/job?in_iframe=1" '
            'class="iCIMS_Anchor"><h3>RN Internship</h3></a></li>')
    result = _html_board("icims", card + card.replace("7600", "7601").replace("RN Internship", "Chef"))
    counts = result.counts.as_dict()
    # Four keywords each read the same two cards: one internship kept, three repeats, four chefs.
    assert len(result) == 1 and "discovered" not in counts
    assert counts["read"] == 8 and counts["discarded"] == {"duplicate": 3, "not_student": 4}


def test_successfactors_counts_distinct_jobs_per_page():
    link = '<a href="/job/Boston-Data-Intern-MA-02110/{id}/" class="jobTitle-link">{t}</a>'
    page = ("<html>" + " " * 2000 + link.format(id=1, t="Data Intern") + link.format(id=1, t="Data Intern")
            + link.format(id=2, t="Director") + "</html>")
    result = _html_board("successfactors", page, token="careers.acme.com")
    counts = result.counts.as_dict()
    # Five keywords, two distinct jobs a page (the repeated link is one job).
    assert len(result) == 1 and "discovered" not in counts
    assert counts["read"] == 10 and counts["discarded"] == {"duplicate": 4, "not_student": 5}


# ------------------------------------------------------------------ scan_boards and the report

def _scan_with(monkeypatch, fetch, n=2):
    monkeypatch.setattr(run_ingest, "RETRY_PAUSE", 0)
    monkeypatch.setitem(run_ingest.BOARD_FETCHERS, "fakeats", fetch)
    reg = {"fakeats": {f"t{i}": {"name": f"Co {i}", "fails": 0} for i in range(n)}}
    metrics = IngestMetrics()
    run_ingest.scan_boards(reg, workers=2, verbose=False, metrics=metrics)
    return metrics.as_dict()


def test_scan_boards_carries_counts_into_the_report(monkeypatch):
    def fetch(c, co):
        counts = counts_of(co)
        counts.reported(5)
        counts.rows(3)
        counts.discard("not_student", 2)
        counts.stop("page_cap")
        return [{"title": "Intern"}]

    report = _scan_with(monkeypatch, fetch)
    assert report["board_scans"]["fakeats"] == {
        "boards": 2, "capped": 2, "stops": {"page_cap": 2}, "read_boards": 2, "read": 6,
        "returned_by_read_boards": 2, "discarded": {"not_student": 4},
        "discovered_boards": 2, "discovered": 10}
    assert report["discrepancies"] == []


def test_an_uninstrumented_adapter_reports_nothing_rather_than_zero(monkeypatch):
    report = _scan_with(monkeypatch, lambda c, co: [{"title": "Intern"}])
    assert report["board_scans"]["fakeats"] == {"boards": 2, "capped": 0}
    assert all("scan" not in f for f in report["board_failures"])


def test_a_retried_board_reports_only_the_attempt_that_counted(monkeypatch):
    calls = {}

    def fetch(c, co):
        calls[co["ats_token"]] = calls.get(co["ats_token"], 0) + 1
        counts_of(co).rows(4)
        if calls[co["ats_token"]] == 1:
            req = httpx.Request("GET", "https://example.test/")
            raise httpx.HTTPStatusError("busy", request=req, response=httpx.Response(503, request=req))
        counts_of(co).discard("not_student", 3)
        return [{"title": "Intern"}]

    report = _scan_with(monkeypatch, fetch, n=1)
    assert report["board_scans"]["fakeats"]["read"] == 4
    assert report["discrepancies"] == []


def test_reconciliation_flags_counts_that_do_not_add_up():
    m = IngestMetrics()
    m.board_result("workday", "a", "success", count=3, scan={"discovered": 2, "read": 5,
                                                              "discarded": {"not_student": 1},
                                                              "capped": False})
    m.board_result("oracle", "b", "success", count=4, scan={"read": 2, "discarded": {}, "capped": False})
    m.board_result("jobvite", "c", "success", count=2, scan={"capped": False})   # nothing measured
    m.count("fetched", 3, source="workday")
    m.count("fetched", 7, source="oracle")
    gaps = {(d["source"], d.get("check")): d.get("difference", d.get("unaccounted"))
            for d in m.as_dict()["discrepancies"]}
    assert gaps == {
        ("workday", "read=returned+discarded"): 1,
        ("workday", "discovered>=read"): 3,
        ("oracle", "read>=returned"): 2,
        ("oracle", "read=returned+discarded"): -2,
        ("oracle", None): -3,   # boards returned 4, pipeline counted 7 fetched
    }
    assert "discovered" not in m.as_dict()["board_scans"]["oracle"]
    assert m.as_dict()["board_scans"]["jobvite"] == {"boards": 1, "capped": 0}


def test_scan_reasons_are_labels_not_text():
    m = IngestMetrics()
    m.board_result("greenhouse", "x", "success", scan={"read": 1, "capped": False,
                                                       "discarded": {"https://evil.test/?a=b": 1}})
    assert "evil" not in json.dumps(m.as_dict())


def test_counts_reject_unknown_reasons():
    counts = ScanCounts()
    with pytest.raises(ValueError):
        counts.discard("because")
    with pytest.raises(ValueError):
        counts.stop("tired")


def test_one_search_without_a_total_makes_the_whole_scan_unmeasured():
    counts = ScanCounts()
    counts.reported(10)
    counts.reported(None)
    counts.reported(5)
    assert "discovered" not in counts.as_dict()


# ------------------------------------------------------------------ whole-source outcomes

def _client(monkeypatch, module, handler):
    real = httpx.Client
    monkeypatch.setattr(module, "client", lambda: real(transport=httpx.MockTransport(handler)))


def _refuse(request):
    raise httpx.ConnectError("refused", request=request)


def test_a_failed_feed_is_not_an_empty_one(monkeypatch):
    m = IngestMetrics()
    _client(monkeypatch, nyc_jobs, _refuse)
    assert nyc_jobs.fetch_nyc_jobs(report=m.source_result) == []
    _client(monkeypatch, uhn, lambda r: httpx.Response(200, json=[]))
    assert uhn.fetch_uhn(report=m.source_result) == []
    sources = m.as_dict()["sources"]
    assert sources["nyc_jobs"] == {"status": "failed", "returned": 0, "cause": "ConnectError"}
    assert sources["uhn"] == {"status": "failed", "returned": 0, "cause": "ValueError"}


def test_an_empty_feed_that_answered_is_empty(monkeypatch):
    m = IngestMetrics()
    _client(monkeypatch, nyc_jobs, lambda r: httpx.Response(200, json=[]))
    nyc_jobs.fetch_nyc_jobs(report=m.source_result)
    _client(monkeypatch, uhn, lambda r: httpx.Response(200, json={"data": [
        {"id": 1, "name": "Registered Nurse", "employment": "Full Time"}]}))
    uhn.fetch_uhn(report=m.source_result)
    sources = m.as_dict()["sources"]
    assert sources["nyc_jobs"] == {"status": "empty", "returned": 0,
                                   "scan": {"read": 0, "discarded": {}, "capped": False}}
    assert sources["uhn"]["status"] == "empty"
    assert sources["uhn"]["scan"] == {"discovered": 1, "read": 1, "discarded": {"not_student": 1},
                                      "capped": False}


def test_nyc_rows_and_their_discards_reconcile(monkeypatch):
    row = {"job_id": "1", "business_title": "Summer Intern", "career_level": "Student",
           "agency": "PARKS", "posting_type": "External"}
    rows = [row, dict(row, posting_type="Internal"), {"business_title": "No id"},
            dict(row, job_id="2", business_title="Director", career_level="Manager"),
            dict(row, job_id="3", post_until="01-JAN-2020")]
    m = IngestMetrics()
    _client(monkeypatch, nyc_jobs, lambda r: httpx.Response(200, json=rows))
    assert len(nyc_jobs.fetch_nyc_jobs(report=m.source_result)) == 1
    report = m.as_dict()
    assert report["sources"]["nyc_jobs"]["scan"]["discarded"] == {
        "unreadable": 1, "duplicate": 1, "not_student": 1, "expired": 1}
    assert report["discrepancies"] == []


def test_a_feed_failing_part_way_is_failed_with_what_it_had(monkeypatch):
    def handler(request):
        if request.url.params["Page"] == "2":
            return httpx.Response(503)
        hit = {"MatchedObjectDescriptor": {"PositionTitle": "Student Trainee (Economist)",
                                           "PositionLocation": [{"LocationName": "Washington, District of Columbia",
                                                                 "CountryCode": "United States"}]}}
        return httpx.Response(200, json={"SearchResult": {"SearchResultCountAll": 900,
                                                          "SearchResultItems": [hit]}})
    m = IngestMetrics()
    _client(monkeypatch, usajobs, handler)
    assert len(usajobs.fetch_usajobs("key", "me@example.test", report=m.source_result)) == 1
    result = m.as_dict()["sources"]["usajobs"]
    assert result["status"] == "failed" and result["cause"] == "503" and result["returned"] == 1


def test_a_feed_without_its_key_is_skipped(monkeypatch):
    monkeypatch.delenv("USAJOBS_API_KEY", raising=False)
    monkeypatch.delenv("SERPAPI_KEY", raising=False)
    m = IngestMetrics()
    usajobs.fetch_usajobs(report=m.source_result)
    google_jobs.fetch_google_jobs(["q"], ["Boston, Massachusetts"], report=m.source_result)
    sources = m.as_dict()["sources"]
    assert sources["usajobs"] == {"status": "skipped", "returned": 0, "cause": "no_api_key"}
    assert sources["google_jobs"]["status"] == "skipped"


def test_one_community_list_failing_beside_one_that_loaded(monkeypatch):
    lists = [{"source": "good", "url": "https://lists.test/good.json", "cycle_years": {}},
             {"source": "broken", "url": "https://lists.test/broken.json", "cycle_years": {}},
             {"source": "reshaped", "url": "https://lists.test/reshaped.json", "cycle_years": {}},
             {"source": "quiet", "url": "https://lists.test/quiet.json", "cycle_years": {}}]

    def handler(request):
        name = request.url.path.rsplit("/", 1)[1]
        if name == "good.json":
            return httpx.Response(200, json=[{"company_name": "A", "title": "SWE Intern", "url": "https://a.test/1"},
                                             {"company_name": "B", "title": "x", "is_visible": False}, "junk"])
        if name == "reshaped.json":
            return httpx.Response(200, json={"listings": []})   # used to read as an empty list
        if name == "quiet.json":
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    m = IngestMetrics()
    _client(monkeypatch, github_lists, handler)
    assert len(github_lists.fetch_github_lists(lists, report=m.source_result)) == 1
    sources = m.as_dict()["sources"]
    assert sources["good"]["status"] == "success"
    assert sources["good"]["scan"]["discarded"] == {"unlisted": 1, "unreadable": 1}
    assert sources["broken"] == {"status": "failed", "returned": 0, "cause": "404"}
    assert sources["reshaped"] == {"status": "failed", "returned": 0, "cause": "ValueError"}
    assert sources["quiet"]["status"] == "empty"


def _google(monkeypatch, failing):
    def handler(request):
        if request.url.path == "/account.json":
            return httpx.Response(200, json={"searches_per_month": 5000, "total_searches_left": 4000})
        if request.url.params["location"] in failing:
            return httpx.Response(500)
        return httpx.Response(200, json={"jobs_results": [
            {"company_name": "MFA", "title": "Museum Intern", "location": request.url.params["location"],
             "apply_options": [{"link": "https://x.test/1"}]}]})
    _client(monkeypatch, google_jobs, handler)
    monkeypatch.setenv("SERPAPI_KEY", "test")
    m = IngestMetrics()
    google_jobs.fetch_google_jobs(["museum internship"], ["Boston, Massachusetts", "Austin, Texas"],
                                  max_searches=2, report=m.source_result)
    return m.as_dict()["sources"]["google_jobs"]


def test_google_jobs_some_searches_failing_is_partial(monkeypatch):
    result = _google(monkeypatch, {"Austin, Texas"})
    assert result["status"] == "partial" and result["cause"] == "500" and result["returned"] == 1


def test_google_jobs_every_search_failing_is_failed_not_empty(monkeypatch):
    result = _google(monkeypatch, {"Austin, Texas", "Boston, Massachusetts"})
    assert result == {"status": "failed", "returned": 0, "cause": "500",
                      "scan": {"capped": False}}


def test_report_source_needs_no_collector():
    report_source(None, "anything", error=ValueError("x"))   # a direct call records nothing


def test_the_cli_writes_source_outcomes_to_the_report(monkeypatch, tmp_path):
    # --public with every public feed unreachable: three failures, none of them an empty feed.
    path = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["run_ingest", "--public", "--metrics", str(path)])
    for name in ("seed_registry", "discover", "probe_boards", "label_boards", "label_sectors",
                 "prune", "refused_count"):
        monkeypatch.setattr(run_ingest, name, lambda *a: 0)
    for name in ("save_registry", "save_cache"):
        monkeypatch.setattr(run_ingest, name, lambda *a: None)
    monkeypatch.setattr(run_ingest, "load_registry", lambda: {})
    monkeypatch.setattr(run_ingest, "run", Mock())
    monkeypatch.setenv("USAJOBS_API_KEY", "k")
    monkeypatch.setenv("USAJOBS_EMAIL", "me@example.test")
    for module in (usajobs, nyc_jobs, uhn):
        _client(monkeypatch, module, _refuse)
    run_ingest.main()
    sources = json.loads(path.read_text())["sources"]
    assert {name: (r["status"], r["cause"]) for name, r in sources.items()} == {
        "usajobs": ("failed", "ConnectError"), "nyc_jobs": ("failed", "ConnectError"),
        "uhn": ("failed", "ConnectError")}
