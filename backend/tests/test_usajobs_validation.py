"""Malformed federal search responses must not look like a healthy empty feed."""
import httpx
import pytest

from internscout.ingest_metrics import IngestMetrics
from internscout.sources import usajobs


def fetch(monkeypatch, payloads):
    calls = []

    def respond(request):
        page = int(request.url.params["Page"])
        calls.append(page)
        return httpx.Response(200, json=payloads[page - 1])

    monkeypatch.setattr(usajobs, "client", lambda: httpx.Client(
        transport=httpx.MockTransport(respond)))
    metrics = IngestMetrics()
    items = usajobs.fetch_usajobs("fixture-key", "fixture@example.test",
                                  report=metrics.source_result)
    return items, metrics.as_dict(), calls


@pytest.mark.parametrize("payload", [
    [], {}, {"Message": "unexpected response"}, {"SearchResult": None},
    {"SearchResult": []},
    {"SearchResult": {"SearchResultCountAll": 0}},
    {"SearchResult": {"SearchResultCountAll": 0, "SearchResultItems": {}}},
    {"SearchResult": {"SearchResultCountAll": 1, "SearchResultItems": [None]}},
    {"SearchResult": {"SearchResultItems": []}},
    {"SearchResult": {"SearchResultCountAll": -1, "SearchResultItems": []}},
    {"SearchResult": {"SearchResultCountAll": True, "SearchResultItems": []}},
])
def test_malformed_http_200_reports_failure(monkeypatch, payload):
    items, report, calls = fetch(monkeypatch, [payload])
    assert items == [] and calls == [1]
    outcome = report["sources"]["usajobs"]
    assert outcome["status"] == "failed"
    assert outcome["cause"] == "ValueError"
    assert outcome["returned"] == 0
    assert "read" not in outcome["scan"]


@pytest.mark.parametrize("total", [0, "0"])
def test_genuine_empty_response_remains_empty(monkeypatch, total):
    payload = {"SearchResult": {"SearchResultCountAll": total, "SearchResultItems": []}}
    items, report, calls = fetch(monkeypatch, [payload])
    assert items == [] and calls == [1]
    assert report["sources"]["usajobs"] == {
        "status": "empty", "returned": 0,
        "scan": {"discovered": 0, "read": 0, "discarded": {}, "capped": False}}
    assert report["discrepancies"] == []


def test_malformed_later_page_retains_prior_rows_and_reports_failed_feed(monkeypatch):
    hit = {"MatchedObjectDescriptor": {
        "PositionTitle": "Student Trainee (Economist)",
        "PositionURI": "https://www.usajobs.gov/job/123",
        "PositionLocation": [{"LocationName": "Washington, District of Columbia",
                              "CountryCode": "United States"}]}}
    first = {"SearchResult": {"SearchResultCountAll": 900, "SearchResultItems": [hit]}}
    items, report, calls = fetch(monkeypatch, [first, {"Message": "unavailable"}])
    assert len(items) == 1 and calls == [1, 2]
    outcome = report["sources"]["usajobs"]
    assert (outcome["status"], outcome["cause"], outcome["returned"]) == ("failed", "ValueError", 1)
    assert outcome["scan"] == {"discovered": 900, "read": 1, "discarded": {}, "capped": False}
    assert report["discrepancies"] == []
