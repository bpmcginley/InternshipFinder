"""Offline fixtures: which adapters can prove a whole scan, and what that proof closes.

Each authoritative adapter is served a small fake API. A scan that read every result its API
reported signals completion and closes the posting that went missing; a capped scan, a failed
keyword or page, and a malformed payload do not. Nothing here touches the network.
"""
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from internscout import pipeline, run_ingest
from internscout.db import Base
from internscout.models import Listing
from internscout.scan_evidence import AUTHORITATIVE, FULL_LIST, SEARCH_SCOPED, evidence_key
from internscout.sources import BOARD_FETCHERS, common, icims_site

NOISE = "Internal Audit Manager"   # what a fuzzy "intern" search returns besides internships


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    common._ROBOTS.clear()
    monkeypatch.setattr(icims_site, "CRAWL_DELAY", 0)
    yield
    common._ROBOTS.clear()


@pytest.fixture
def listing_db(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'scan.db'}")
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(pipeline, "SessionLocal", sessions)
    monkeypatch.setattr(pipeline, "init_db", lambda: None)
    yield sessions
    engine.dispose()


# ---------------------------------------------------------------------------- fake APIs
# Each server takes {keyword: [titles]} (keyword None for unsearched boards) and a mode:
#   complete  - every page as the API would serve it
#   capped    - the first keyword holds more results than the adapter's page cap
#   failed    - one keyword (or the second page) answers 500
#   malformed - the result total or the rows list is missing
# The result is a request handler for httpx.MockTransport.

def _rows(by_kw, kw, mode, cap_noise):
    rows = list(by_kw.get(kw, []))
    if mode == "capped" and kw == next(iter(by_kw)):
        rows += [NOISE] * cap_noise
    return rows


def _robots_or_detail(request):
    return httpx.Response(404)   # no robots.txt (nothing forbidden) and no detail pages


def workday(by_kw, mode):
    def handle(request):
        if request.method != "POST":
            return _robots_or_detail(request)
        body = json.loads(request.content)
        kw, off, lim = body["searchText"], body["offset"], body["limit"]
        # Every board searches only "intern" by default, so the failure is its second page.
        if mode == "failed" and (kw == "co-op" or off > 0):
            return httpx.Response(500)
        rows = _rows(by_kw, kw, mode, 1000)
        if mode == "failed":
            rows += [NOISE] * 30   # a second page to fail on
        page = [{"title": t, "externalPath": f"/job/{kw}-{i}", "locationsText": "Boston, MA"}
                for i, t in enumerate(rows[off:off + lim], off)]
        data = {"jobPostings": page}
        if off == 0:
            data["total"] = len(rows)
        if mode == "malformed":
            data.pop("total", None)
        return httpx.Response(200, json=data)
    return handle


def oracle(by_kw, mode):
    def handle(request):
        url = str(request.url)
        if "findReqs" not in url:
            return _robots_or_detail(request)
        kw = url.split("keyword=")[1].split(",")[0]
        off = int(url.split("offset=")[1].split(",")[0])
        if mode == "failed" and kw == "co-op":
            return httpx.Response(500)
        rows = _rows(by_kw, kw, mode, 1000)
        page = [{"Id": f"{kw}-{i}", "Title": t, "PrimaryLocation": "Boston, MA, United States",
                 "PrimaryLocationCountry": "US", "ShortDescriptionStr": "Student role"}
                for i, t in enumerate(rows[off:off + 100], off)]
        head = {"TotalJobsCount": len(rows), "requisitionList": page}
        if mode == "malformed":
            return httpx.Response(200, json={"items": []})
        return httpx.Response(200, json={"items": [head]})
    return handle


def smartrecruiters(by_kw, mode):
    def handle(request):
        if not request.url.path.endswith("/postings"):
            return _robots_or_detail(request)
        q = parse_qs(request.url.query.decode())
        off = int(q["offset"][0])
        if mode == "failed" and off > 0:
            return httpx.Response(500)
        rows = _rows(by_kw, q["q"][0], mode, 1000)
        if mode == "failed":
            rows += [NOISE] * 150   # a second page to fail on
        page = [{"id": str(i), "name": t, "location": {"city": "Boston", "region": "MA", "country": "us"}}
                for i, t in enumerate(rows[off:off + 100], off)]
        data = {"totalFound": len(rows), "content": page}
        if mode == "malformed":
            data.pop("content")
        return httpx.Response(200, json=data)
    return handle


def taleo(by_kw, mode):
    def handle(request):
        if request.method != "POST":
            return _robots_or_detail(request)
        body = json.loads(request.content)
        kw, page_no = body["fieldData"]["fields"]["KEYWORD"], body["pageNo"]
        if mode == "failed" and kw == "co-op":
            return httpx.Response(500)
        rows = _rows(by_kw, kw, mode, 1000)
        start = (page_no - 1) * 25
        page = [{"contestNo": f"{kw}-{i}", "linkedColumn": 0, "locationsColumns": [1],
                 "column": [t, "US-MA-Boston"]} for i, t in enumerate(rows[start:start + 25], start)]
        data = {"pagingData": {"totalCount": len(rows)}, "requisitionList": page}
        if mode == "malformed":
            data["pagingData"] = {}
        return httpx.Response(200, json=data)
    return handle


def eightfold(by_kw, mode):
    def handle(request):
        if request.url.path != "/api/pcsx/search":
            return _robots_or_detail(request)
        q = parse_qs(request.url.query.decode())
        kw, start = q["query"][0], int(q["start"][0])
        if mode == "failed" and kw == "co-op":
            return httpx.Response(500)
        rows = _rows(by_kw, kw, mode, 1000)
        page = [{"id": f"{kw}{i}", "name": t, "standardizedLocations": ["Boston, MA, US"],
                 "positionUrl": f"/careers/job/{kw}{i}"} for i, t in enumerate(rows[start:start + 10], start)]
        data = {"count": len(rows), "positions": page}
        if mode == "malformed":
            data.pop("count")
        return httpx.Response(200, json={"data": data})
    return handle


def icims_site_api(by_kw, mode):
    def handle(request):
        if request.url.path != "/api/jobs":
            return _robots_or_detail(request)
        page_no = int(parse_qs(request.url.query.decode())["page"][0])
        if mode == "failed" and page_no > 1:
            return httpx.Response(500)
        rows = _rows(by_kw, None, mode, 1000)
        if mode == "failed":
            rows += [NOISE] * 150
        start = (page_no - 1) * 100
        jobs = [{"data": {"title": t, "slug": str(i), "city": "Boston", "state": "MA", "country_code": "US"}}
                for i, t in enumerate(rows[start:start + 100], start)]
        data = {"totalCount": len(rows), "jobs": jobs}
        if mode == "malformed":
            data.pop("totalCount")
        return httpx.Response(200, json=data)
    return handle


def workable(by_kw, mode):
    def handle(request):
        if mode == "failed":
            return httpx.Response(500)
        jobs = [{"title": t, "url": f"https://apply.workable.com/acme/j/{i}",
                 "locations": [{"country": "United States", "countryCode": "US", "city": "Boston", "region": "MA"}]}
                for i, t in enumerate(by_kw.get(None, []))]
        return httpx.Response(200, json={"name": "Acme"} if mode == "malformed" else {"jobs": jobs})
    return handle


def bamboohr(by_kw, mode):
    def handle(request):
        if request.url.path != "/careers/list":
            return _robots_or_detail(request)
        if mode == "failed":
            return httpx.Response(500)
        rows = [{"id": str(i), "jobOpeningName": t,
                 "atsLocation": {"city": "Boston", "state": "MA", "country": "United States"}}
                for i, t in enumerate(by_kw.get(None, []))]
        stated = len(rows) + (500 if mode == "capped" else 0)   # the list does not add up
        data = {"meta": {"totalCount": stated}, "result": rows}
        if mode == "malformed":
            data.pop("result")
        return httpx.Response(200, json=data)
    return handle


def rippling(by_kw, mode):
    def handle(request):
        if not request.url.path.endswith("/jobs"):
            return _robots_or_detail(request)
        if mode == "failed":
            return httpx.Response(500)
        rows = [{"uuid": f"u{i}", "name": t, "url": f"https://ats.rippling.com/acme/jobs/u{i}",
                 "workLocation": {"label": "Boston, MA"}} for i, t in enumerate(by_kw.get(None, []))]
        # An object envelope may be one page of a paged answer; only the bare array is the board.
        return httpx.Response(200, json={"jobs": rows} if mode == "malformed" else rows)
    return handle


ADP_CID = "89da4960-4d45-4b46-b7aa-5959c5f71827"


def adp(by_kw, mode):
    def handle(request):
        if not request.url.path.endswith("/job-requisitions"):
            return _robots_or_detail(request)
        skip = int(parse_qs(request.url.query.decode())["$skip"][0])
        if mode == "failed" and skip > 0:
            return httpx.Response(500)
        rows = _rows(by_kw, None, mode, 1200)
        if mode == "failed":
            rows += [NOISE] * 150
        reqs = [{"itemID": str(i), "requisitionTitle": t,
                 "requisitionLocations": [{"address": {"cityName": "Boston", "countryCode": "US",
                                                       "countrySubdivisionLevel1": {"codeValue": "MA"}}}],
                 "customFieldGroup": {"stringFields": [{"nameCode": {"codeValue": "ExternalJobID"},
                                                        "stringValue": f"j{i}"}]}}
                for i, t in enumerate(rows[skip:skip + 100], skip)]
        data = {"meta": {"totalNumber": len(rows)}, "jobRequisitions": reqs}
        if mode == "malformed":
            data["meta"] = {}
        return httpx.Response(200, json=data)
    return handle


# ats: (registry token, fake API, first keyword the adapter searches or None, modes it has)
ADAPTERS = {
    "workday": ("acme|wd1|Careers", workday, "intern", {"capped", "failed", "malformed"}),
    "oracle": ("acme.fa.oraclecloud.com|CX_1", oracle, "intern", {"capped", "failed", "malformed"}),
    "smartrecruiters": ("Acme", smartrecruiters, "intern", {"capped", "failed", "malformed"}),
    "taleo": ("acme|ext|123456", taleo, "intern", {"capped", "failed", "malformed"}),
    "eightfold": ("acme|acme.com", eightfold, "intern", {"capped", "failed", "malformed"}),
    "icims_site": ("careers.acme.com", icims_site_api, None, {"capped", "failed", "malformed"}),
    "workable": ("acme", workable, None, {"failed", "malformed"}),
    "bamboohr": ("acme", bamboohr, None, {"capped", "failed", "malformed"}),
    "rippling": ("acme", rippling, None, {"failed", "malformed"}),
    "adp": (ADP_CID, adp, None, {"capped", "failed", "malformed"}),
}


def scan(ats, titles, mode="complete"):
    token, server, kw, _ = ADAPTERS[ats]
    co = {"name": "Acme", "ats_token": token, "is_quant_target": False, "sector": None, "location": None}
    with httpx.Client(transport=httpx.MockTransport(server({kw: titles}, mode))) as c:
        return run_ingest._fetch_board(c, ats, co), co


def cases(kind):
    return [a for a, spec in ADAPTERS.items() if kind in spec[3]]


def test_every_board_adapter_is_classified():
    # A new adapter has to say whether it can prove a whole scan; docs/coverage-research explains each.
    unproven = {"icims", "successfactors", "jobvite", "jazzhr"}
    assert set(BOARD_FETCHERS) == AUTHORITATIVE | unproven
    assert not FULL_LIST & SEARCH_SCOPED
    assert set(ADAPTERS) | {"greenhouse", "lever", "ashby", "recruitee"} == AUTHORITATIVE


@pytest.mark.parametrize("ats", list(ADAPTERS))
def test_complete_scan_signals_and_closes_the_missing_posting(listing_db, ats):
    first, _ = scan(ats, ["Software Engineer Intern", "Data Science Intern"])
    assert first.complete is True and len(first) == 2
    pipeline.run(list(first), verbose=False)
    second, _ = scan(ats, ["Software Engineer Intern"])
    assert second.complete is True
    token = ADAPTERS[ats][0]
    stats = pipeline.run(list(second), completed_boards={(ats, token)}, verbose=False)
    assert stats["closed"] == 1
    with listing_db() as db:
        assert {r.title: r.status for r in db.scalars(select(Listing))} == {
            "Software Engineer Intern": "open", "Data Science Intern": "closed"}


@pytest.mark.parametrize("ats", list(ADAPTERS))
def test_complete_empty_board_is_still_evidence(ats):
    result, _ = scan(ats, [])
    assert result == [] and result.complete is True


@pytest.mark.parametrize("ats", cases("capped"))
def test_capped_scan_does_not_signal(ats):
    result, co = scan(ats, ["Software Engineer Intern"], "capped")
    assert result.complete is False and "_scan_complete" not in co


@pytest.mark.parametrize("ats", cases("failed"))
def test_one_failed_keyword_or_page_raises_without_evidence(ats):
    token, server, kw, _ = ADAPTERS[ats]
    co = {"name": "Acme", "ats_token": token, "sector": None, "location": None}
    with httpx.Client(transport=httpx.MockTransport(server({kw: ["Software Engineer Intern"]}, "failed"))) as c:
        with pytest.raises(httpx.HTTPStatusError):
            run_ingest._fetch_board(c, ats, co)
    assert "_scan_complete" not in co


@pytest.mark.parametrize("ats", cases("malformed"))
def test_malformed_payload_does_not_signal(ats):
    result, co = scan(ats, ["Software Engineer Intern"], "malformed")
    assert result.complete is False and "_scan_complete" not in co


@pytest.mark.parametrize("ats", ["workday", "oracle", "smartrecruiters", "taleo", "eightfold",
                                 "icims_site", "workable", "bamboohr", "adp"])
def test_a_payload_that_is_not_an_object_raises(ats):
    token = ADAPTERS[ats][0]
    co = {"name": "Acme", "ats_token": token, "sector": None, "location": None}

    def handle(request):
        if request.url.path.endswith("robots.txt"):
            return httpx.Response(404)
        return httpx.Response(200, json=["not", "an", "object"])

    with httpx.Client(transport=httpx.MockTransport(handle)) as c:
        with pytest.raises(ValueError):
            run_ingest._fetch_board(c, ats, co)
    assert "_scan_complete" not in co


def test_workday_dry_stop_past_the_core_offset_is_not_complete():
    # Matches thin out past CORE_OFFSET and the read stops early: not every result was read.
    titles = ["Software Engineer Intern"] * 200 + [NOISE] * 150
    result, _ = scan("workday", titles)
    assert len(result) == 200 and result.complete is False


def _workday_scan(by_kw, sector=None):
    server = workday(by_kw, "complete")
    co = {"name": "Acme", "ats_token": "acme|wd1|Careers", "sector": sector, "location": None}
    searched = []

    def handle(request):
        if request.method == "POST":
            searched.append(json.loads(request.content)["searchText"])
        return server(request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as c:
        return run_ingest._fetch_board(c, "workday", co), list(dict.fromkeys(searched))


def test_workday_every_keyword_searched_must_complete(monkeypatch):
    # With co-op switched on, "intern" read whole is not enough when "co-op" hit the page cap.
    monkeypatch.setenv("WORKDAY_EXTRA_KEYWORDS", "co-op")
    result, searched = _workday_scan({"intern": ["Software Engineer Intern"],
                                      "co-op": ["Mechanical Co-op"] + [NOISE] * 1000})
    assert searched == ["intern", "co-op"] and result.complete is False


def test_workday_default_evidence_covers_only_the_intern_search():
    # Co-op is off by default, so its results are never asked for and cannot hold back the
    # evidence: the one search the run made was read to its total.
    result, searched = _workday_scan({"intern": ["Software Engineer Intern"],
                                      "co-op": ["Mechanical Co-op"] + [NOISE] * 1000})
    assert searched == ["intern"] and result.complete is True


def test_workday_switched_on_co_op_read_whole_is_evidence(monkeypatch):
    monkeypatch.setenv("WORKDAY_EXTRA_KEYWORDS", "co-op")
    result, searched = _workday_scan({"intern": ["Software Engineer Intern"],
                                      "co-op": ["Mechanical Co-op"]})
    assert searched == ["intern", "co-op"] and result.complete is True and len(result) == 2


def test_workday_health_student_search_must_complete_too():
    # The hospital "student" search predates the expansion and still runs; a capped one is a gap.
    result, searched = _workday_scan({"intern": ["Pharmacy Intern"],
                                      "student": ["Student Nurse Technician"] + [NOISE] * 1000},
                                     sector="health")
    assert searched == ["intern", "student"] and result.complete is False


def test_keyword_scoped_evidence_cannot_close_a_posting_only_a_list_found(listing_db):
    # A community list's "Summer Analyst" on a Workday board never answers searchText="intern",
    # so a complete keyword scan of that board says nothing about it.
    listed = {"company_name": "Acme", "title": "Summer Analyst Intern Program",
              "locations": ["Boston, MA"], "source": "vanshb03",
              "url": "https://acme.wd1.myworkdayjobs.com/Careers/job/Boston/Summer-Analyst_R1"}
    pipeline.run([listed], verbose=False)
    empty, _ = scan("workday", [])
    assert empty.complete is True
    assert pipeline.run([], completed_boards={("workday", "acme|wd1|Careers")}, verbose=False)["closed"] == 0


def test_full_list_evidence_closes_a_posting_a_list_found(listing_db):
    listed = {"company_name": "Acme", "title": "Software Engineer Intern", "locations": ["Boston, MA"],
              "source": "vanshb03", "url": "https://ats.rippling.com/acme/jobs/gone"}
    pipeline.run([listed], verbose=False)
    empty, _ = scan("rippling", [])
    assert pipeline.run(list(empty), completed_boards={("rippling", "acme")}, verbose=False)["closed"] == 1


def test_registry_extras_are_folded_into_the_evidence_key():
    assert evidence_key("taleo", "Acme|EXT|123456") == ("taleo", "acme|ext")
    assert evidence_key("eightfold", "acme|acme.com") == ("eightfold", "acme")
    assert evidence_key("workday", "Acme|wd1|Careers") == ("workday", "acme|wd1|careers")


@pytest.mark.parametrize("ats,body", [
    ("icims", "<html>" + " " * 3000 + "</html>"),
    ("successfactors", "<html>" + " " * 3000 + "</html>"),
    ("jobvite", "<html></html>"),
    ("jazzhr", "<html></html>"),
])
def test_html_adapters_never_signal_completion(ats, body):
    # No result total to check a scrape against: an empty page and a changed template look alike.
    co = {"name": "Acme", "ats_token": "acme", "sector": None, "location": None}
    handle = lambda request: (httpx.Response(404) if request.url.path.endswith("robots.txt")
                              else httpx.Response(200, text=body))
    with httpx.Client(transport=httpx.MockTransport(handle)) as c:
        result = run_ingest._fetch_board(c, ats, co)
    assert result == [] and result.complete is False


def test_workday_hard_page_cap_is_not_complete():
    # 500 real internships: the read runs to MAX_OFFSET (400) without a dry stop, and still is not whole.
    result, _ = scan("workday", [f"Engineering Intern {i}" for i in range(500)])
    assert len(result) == 400 and result.complete is False
