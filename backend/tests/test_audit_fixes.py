"""Regression tests for the bugs the 2026-09 audit found in normalize, geo, discover and the fetchers.

Each test names the posting or string that went wrong, so the reason the rule exists stays on record.
"""
from datetime import date, datetime, timezone

import httpx

from internscout.discover import MAX_FAILS, prune, record_result
from internscout.geo import looks_us, state_of
from internscout.normalize import (extract_salary, lone_description_year, normalize_title,
                                   parse_term_from_text, parse_term_pair)
from internscout.region import place_bare_cities
from internscout.run_ingest import _transient
from internscout.sources import google_jobs
from internscout.sources.workday import MAX_DETAIL, fetch_workday_board


# ---------- term ----------
def test_a_place_name_is_not_a_season():
    for place in ("Intern - Silver Spring, MD", "Cold Spring Harbor Laboratory intern", "Intern, Fall River, MA",
                  "Winter Park, FL intern", "Spring, TX intern", "Spring Boot developer intern"):
        assert parse_term_from_text(place) == (None, None), place
    assert parse_term_from_text("Spring 2027 Tax Intern") == ("Spring", 2027)
    assert parse_term_from_text("Winter 2027 Co-op") == ("Winter", 2027)


def test_a_description_year_counts_only_when_it_can_be_the_term():
    assert parse_term_pair("We were founded in 2021. Our Summer 2027 program runs ten weeks.") == ("Summer", 2027)
    assert parse_term_pair("2027 Summer Analyst") == ("Summer", 2027)
    assert parse_term_pair("Students graduating in 2028 may apply.") == (None, None)
    now = datetime(2026, 9, 18, tzinfo=timezone.utc)
    assert lone_description_year("Founded in 2021, we build rockets.", now) is None
    assert lone_description_year("You must be graduating between December 2026 and June 2027.", now) is None
    assert lone_description_year("Interns start in June 2027.", now) == 2027
    assert lone_description_year("Copyright 2026 Example Corp.", now) is None


# ---------- title ----------
def test_a_two_letter_tail_that_is_not_a_state_stays_in_the_title():
    assert normalize_title("Research, ML") == "research ml"
    assert normalize_title("Summer 2027 Student Intern, AI") == "student ai"
    assert normalize_title("Intern, IT") == "it"


def test_a_state_tail_never_takes_the_job_words_with_it():
    assert normalize_title("Marketing Intern, NY") == "marketing"
    assert normalize_title("Marketing Intern, NY") != normalize_title("Finance Intern, NY")
    # The ordinary case is unchanged: a real "City, ST" after a separator still goes.
    assert normalize_title("HR Intern - Long Beach, CA") == "hr"
    assert normalize_title("Engineering Intern | Austin, TX") == "engineering"


# ---------- geo ----------
def test_every_spelling_of_washington_dc_is_dc():
    for loc in ("Washington DC", "Washington, D.C.", "Washington D.C. Metro", "Washington, DC"):
        assert state_of(loc) == "DC", loc
    assert state_of("Seattle, Washington") == "WA"
    assert state_of("Washington") == "WA"


def test_a_country_code_is_not_a_state():
    for loc in ("Pune, IN", "Berlin, DE", "Toronto, CA", "Bogota, CO", "Casablanca, MA"):
        assert not looks_us(loc), loc
    for loc in ("Ontario, CA", "Vancouver, WA", "Indianapolis, IN", "Wilmington, DE", "Dublin, OH",
                "New Berlin, WI 53151", "Panama City, FL", "Waterloo, IA"):
        assert looks_us(loc), loc


def test_a_bare_foreign_city_is_not_stamped_with_the_boards_state():
    items = [{"company_name": "Acme", "locations": ["Quezon City"]}, {"company_name": "Acme", "locations": ["Danvers"]}]
    place_bare_cities(items, "MA")
    assert items[0]["locations"] == ["Quezon City"]
    assert items[1]["locations"] == ["Danvers, MA"]


# ---------- salary ----------
def test_a_benefit_or_company_figure_is_not_the_pay():
    assert extract_salary("401(k) match up to $5,000. Pay is $28/hour.") == "$28/hour"
    assert extract_salary("We donated $250,000 to local schools last year.") is None
    assert extract_salary("$3 billion in assets under management") is None
    assert extract_salary("Tuition reimbursement of $5,250 per year") is None
    assert extract_salary("Signing bonus $10,000") is None


def test_real_pay_is_still_found():
    assert extract_salary("The salary range is $60,000 - $70,000.") == "$60,000 - $70,000"
    assert extract_salary("Pay: $22.50 - $30.00 per hour") == "$22.50 - $30.00 per hour"
    assert extract_salary("Interns earn $8,000 for the summer") == "$8,000"
    assert extract_salary("$25/hr") == "$25/hr"


# ---------- board failures ----------
def test_a_bad_day_counts_once_and_a_good_run_clears_it():
    reg = {"greenhouse": {"acme": {"name": "Acme"}}}
    for _ in range(6):   # six failed runs on one day: the ingest runs four times a day
        record_result(reg, "greenhouse", "acme", False, today=date(2026, 9, 18))
    assert reg["greenhouse"]["acme"]["fails"] == 1
    assert prune(reg) == 0
    for d in range(19, 19 + MAX_FAILS - 1):
        record_result(reg, "greenhouse", "acme", False, today=date(2026, 9, d))
    assert reg["greenhouse"]["acme"]["fails"] == MAX_FAILS
    record_result(reg, "greenhouse", "acme", True)
    assert reg["greenhouse"]["acme"] == {"name": "Acme", "fails": 0}
    assert prune(reg) == 0


def test_a_board_that_fails_on_enough_days_is_pruned():
    reg = {"lever": {"gone": {"name": "Gone"}}}
    for d in range(1, MAX_FAILS + 1):
        record_result(reg, "lever", "gone", False, today=date(2026, 9, d))
    assert prune(reg) == 1 and reg["lever"] == {}


def test_a_connection_error_is_retried():
    assert _transient(httpx.ConnectError("dns"))
    assert _transient(httpx.ReadTimeout("slow"))
    resp = httpx.Response(404, request=httpx.Request("GET", "https://example.com"))
    assert not _transient(httpx.HTTPStatusError("gone", request=resp.request, response=resp))


# ---------- paid searches ----------
def test_a_push_never_spends_google_searches(monkeypatch):
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.delenv("SERPAPI_EVERY_RUN", raising=False)

    def boom(*a, **k):
        raise AssertionError("a push-triggered run must not open a connection")
    monkeypatch.setattr(google_jobs, "client", boom)
    assert google_jobs.fetch_google_jobs(["intern"], ["Boston, MA"], api_key="k") == []


# ---------- workday detail cap ----------
class _Resp:
    def __init__(self, payload, status_code=200):
        self._p, self.status_code, self.text = payload, status_code, ""

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


class _FarBoard:
    """MAX_DETAIL + 10 out-of-region postings first, then one "2 Locations" posting."""

    def __init__(self):
        self.details = []
        self.rows = [{"title": "Software Intern", "externalPath": "/job/%d" % i, "locationsText": "Pune, India"}
                     for i in range(MAX_DETAIL + 10)]
        self.rows.append({"title": "Finance Intern", "externalPath": "/job/multi", "locationsText": "2 Locations"})

    def post(self, url, headers=None, json=None):
        off = json["offset"]
        return _Resp({"total": len(self.rows), "jobPostings": self.rows[off:off + json["limit"]]})

    def get(self, url, headers=None, timeout=None):
        if url.endswith("robots.txt"):
            return _Resp({}, 404)
        self.details.append(url)
        return _Resp({"jobPostingInfo": {"location": "Boston, MA", "additionalLocations": ["Hartford, CT"],
                                         "jobDescription": "<p>Ten week program.</p>"}})


def test_a_multi_location_posting_far_down_the_list_still_gets_its_detail_page():
    board = _FarBoard()
    co = {"name": "Farco", "ats_token": "farco|wd1|Farco", "is_quant_target": False, "sector": None, "location": None}
    out = fetch_workday_board(board, co)
    multi = [o for o in out if o["title"] == "Finance Intern"][0]
    assert any(u.endswith("/job/multi") for u in board.details)
    assert "2 Locations" not in multi["locations"]
    assert any("Boston" in l for l in multi["locations"])


# ---------- apply link ----------
def test_a_link_that_is_not_http_is_never_a_listing():
    from internscout.normalize import _dead_url
    for bad in ("javascript:alert(1)", "data:text/html,x", " JavaScript:void(0)", "/careers/123", "mailto:hr@example.com"):
        assert _dead_url(bad), bad
    for ok in ("https://boards.greenhouse.io/acme/jobs/1", "http://example.com/job", "", None):
        assert not _dead_url(ok), ok


# ---------- full-time jobs dated like a term ----------
def test_a_dated_full_time_job_is_not_an_internship():
    from internscout.classify import stage_of
    for t in ("Operations Management Development Program - Summer 2027 Start",
              "Risk Consulting Associate - Business Applications - Summer 2027", "Civil Associate I, Summer 2027",
              "Tax Associate Summer 2027 Start", "2027 PhD Graduate - Rotational Discovery Program",
              "Predoctoral Research Associate (Summer 2027)"):
        assert stage_of(t) == [], t


def test_the_student_roles_that_look_like_them_stay():
    from internscout.classify import stage_of
    for t in ("Summer Associate 2027", "2027 Summer Associate - Investment Banking", "Audit Intern - Summer 2027",
              "Summer 2027 - IEF - Systems Engineering - Collegiate Associate in GAC (Savannah)",
              "CGSR Undergraduate Research Associate - Spring 2027", "Software Engineering Intern - Summer 2027 Start",
              "Early Career Mechanical Engineering - Summer 2027", "MS Graduate Student Intern - Summer 2027"):
        assert stage_of(t), t


# ---------- same job ----------
def test_a_job_id_in_the_query_keeps_two_postings_apart():
    from internscout.dedupe import same_job
    a = "https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=338311&lang=en"
    b = "https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=338402"
    assert not same_job(a, b)
    assert same_job(a, a.replace("&lang=en", "&src=google"))
    assert not same_job("https://apply.careers.microsoft.com/careers?pid=1&sort_by=x",
                        "https://apply.careers.microsoft.com/careers?pid=2&sort_by=x")
    # unchanged: arrival markers are still ignored, and a Greenhouse id still wins
    assert same_job("https://careers-acme.icims.com/jobs/12/x/job?icims=1", "https://careers-acme.icims.com/jobs/12/x/job")
    assert same_job("https://coinbase.com/careers/positions/8168315?gh_jid=8168315",
                    "https://boards.greenhouse.io/embed/job_app?token=8168315")


# ---------- registry file ----------
def test_a_corrupt_registry_stops_the_run_instead_of_reading_as_empty(tmp_path, monkeypatch):
    import pytest
    from internscout import discover
    p = tmp_path / "registry.json"
    monkeypatch.setattr(discover, "REGISTRY_PATH", str(p))
    monkeypatch.setattr(discover, "DATA_DIR", str(tmp_path))
    assert discover.load_registry() == {}            # no file yet is still fine
    p.write_text('{"greenhouse": {"acme": ', encoding="utf-8")
    with pytest.raises(RuntimeError):
        discover.load_registry()


def test_a_registry_that_lost_most_of_its_boards_is_not_saved(tmp_path, monkeypatch):
    import json
    import pytest
    from internscout import discover
    p = tmp_path / "registry.json"
    monkeypatch.setattr(discover, "REGISTRY_PATH", str(p))
    monkeypatch.setattr(discover, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("REGISTRY_ALLOW_SHRINK", raising=False)
    big = {"greenhouse": {"co%d" % i: {"name": "Co %d" % i} for i in range(300)}}
    discover.save_registry(big)
    assert len(json.loads(p.read_text(encoding="utf-8"))["greenhouse"]) == 300
    with pytest.raises(RuntimeError):
        discover.save_registry({"greenhouse": {"co1": {"name": "Co 1"}}})
    assert len(json.loads(p.read_text(encoding="utf-8"))["greenhouse"]) == 300   # the old file is untouched
    small = {"greenhouse": {k: v for k, v in list(big["greenhouse"].items())[:280]}}
    discover.save_registry(small)                     # an ordinary prune still saves
    assert not (tmp_path / "registry.json.tmp").exists()


# ---------- age ----------
def test_an_untermed_posting_over_a_year_old_is_dropped():
    from internscout.normalize import _zombie
    now = datetime(2026, 9, 18, tzinfo=timezone.utc)
    assert _zombie(datetime(2013, 2, 1, tzinfo=timezone.utc), None, None, now)
    assert _zombie(datetime(2025, 9, 1), None, None, now)                      # a naive date is read as UTC
    assert not _zombie(datetime(2025, 10, 1, tzinfo=timezone.utc), None, None, now)
    assert not _zombie(datetime(2024, 1, 1, tzinfo=timezone.utc), "Summer", 2027, now)   # a term decides, not the date
    assert not _zombie(None, None, None, now)
