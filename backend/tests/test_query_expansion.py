"""Offline query-response fixtures for opportunities omitted by English intern searches.

Public title evidence and live-sample limits are recorded in query-expansion.md.
Responses here are deliberately small fixtures, not a production listing-growth claim.
"""
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from internscout.region import evaluate_locations
from internscout.sources import common, eightfold, oracle, taleo


CO = {"name": "Fixture Employer", "ats_token": "fixture", "is_quant_target": False}


@pytest.fixture(autouse=True)
def clear_robots():
    common._ROBOTS.clear()
    yield
    common._ROBOTS.clear()


def oracle_row(id, title, location="Boston, MA, United States", country="US"):
    return {"Id": id, "Title": title, "PrimaryLocation": location,
            "PrimaryLocationCountry": country, "ShortDescriptionStr": "Student opportunity"}


def test_oracle_recovers_coops_student_jobs_and_french_titles_without_duplicates():
    # The co-op title/location is from Stantec's public list response on 2026-10-16.
    # Other rows are synthetic controls for alternative wording and relevance-search noise.
    intern = oracle_row("1", "Engineering Intern")
    by_keyword = {
        "intern": [intern, oracle_row("staff", "Manager, Internal Controls")],
        "co-op": [intern, oracle_row("1008127", "Architectural Technologist Co-op Student - Winter 2027",
                                    "Regina, SK, Canada", "CA")],
        "student": [intern, oracle_row("3", "Student Assistant, Research")],
        "stagiaire": [oracle_row("4", "Stagiaire en génie électrique", "Montréal, QC, Canada", "CA"),
                      oracle_row("5", "Stagiaire en génie électrique", "Paris, France", "FR")],
    }
    queries = []

    def respond(request):
        if "findReqs" not in str(request.url):
            return httpx.Response(404)
        query = str(request.url).split("keyword=")[1].split(",")[0]
        queries.append(query)
        rows = by_keyword.get(query, [])
        return httpx.Response(200, json={"items": [{"TotalJobsCount": len(rows), "requisitionList": rows}]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        out = oracle.fetch_oracle_board(client, dict(CO, ats_token="fixture.example|CX_1"))
    assert {row["_req_id"] for row in out} == {"1", "1008127", "3", "4"}
    assert len(out) == 4
    assert {"co-op", "student", "stagiaire"}.issubset(queries)
    assert next(row for row in out if row["_req_id"] == "1008127")["locations"] == ["Regina, SK, Canada"]


def test_oracle_alternative_queries_remain_bounded_and_paginate_separately():
    offsets = {}

    def respond(request):
        url = str(request.url)
        if "findReqs" not in url:
            return httpx.Response(404)
        query = url.split("keyword=")[1].split(",")[0]
        offset = int(url.split("offset=")[1].split(",")[0])
        offsets.setdefault(query, []).append(offset)
        return httpx.Response(200, json={"items": [{"TotalJobsCount": 10000, "requisitionList": []}]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert oracle.fetch_oracle_board(client, dict(CO, ats_token="fixture.example|CX_1")) == []
    assert offsets["intern"] == offsets["co-op"] == offsets["student"] == offsets["stagiaire"]
    assert offsets["intern"][0] == 0
    assert offsets["intern"][-1] < oracle.MAX_OFFSET
    assert len(offsets["intern"]) == oracle.MAX_OFFSET // oracle.PAGE


def taleo_row(id, title, country="Canada-Quebec-Quebec"):
    return {"contestNo": id, "linkedColumn": 0, "locationsColumns": [1], "column": [title, country]}


def test_taleo_french_query_recovers_a_french_only_role_and_deduplicates():
    # Tetra Tech's public French search page showed this title and contest number.
    french = taleo_row("71500003729", "Stagiaire estimateur(trice) en électricité")
    intern = taleo_row("1", "Engineering Intern", "US-New York-New York")
    queries = []

    def respond(request):
        if request.method != "POST":
            return httpx.Response(404)
        body = json.loads(request.content)
        query = body["fieldData"]["fields"]["KEYWORD"]
        queries.append(query)
        rows = [intern, french, taleo_row("2", "Electrical Engineer")] if query == "stagiaire" else [intern]
        return httpx.Response(200, json={"pagingData": {"totalCount": len(rows)}, "requisitionList": rows})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        out = taleo.fetch_taleo_board(client, dict(CO, ats_token="fixture|ext|123456"))
    assert "stagiaire" in queries
    assert len(out) == 2
    assert {row["title"] for row in out} == {"Engineering Intern", french["column"][0]}
    assert next(row for row in out if "71500003729" in row["url"])["locations"] == ["Quebec, Quebec, Canada"]


@pytest.mark.parametrize("raw, expected", [
    (["Ottawa, ON, CA"], ["Ottawa, ON, Canada"]),
    (["Montréal, QC, CAN"], ["Montréal, QC, Canada"]),
    (["Victoria, BC, Canada"], ["Victoria, BC, Canada"]),
    (["ON,CA"], ["ON, Canada"]),
    (["Ontario, CA, US"], ["Ontario, CA"]),
    (["San Francisco, CA, USA"], ["San Francisco, CA"]),
    (["Ottawa, ON, CA", "Ottawa, ON, CA", "Austin, TX, US"], ["Ottawa, ON, Canada", "Austin, TX"]),
    (["London, England, GB", "Unknown, ZZ, CA", "Paris, FR"], []),
])
def test_eightfold_preserves_canada_without_moving_california(raw, expected):
    assert eightfold._locations(raw) == expected


def test_eightfold_alternative_query_retains_canadian_role_and_rejects_staff():
    queries = []

    def respond(request):
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /\nAllow: /api/pcsx\n")
        query = parse_qs(urlparse(str(request.url)).query)["query"][0]
        queries.append(query)
        rows = [{"id": "staff", "name": "Manager, Internal Controls", "standardizedLocations": ["Austin, TX, US"]}]
        if query == "stagiaire":
            rows += [{"id": "student", "name": "Stagiaire en science des données",
                      "standardizedLocations": ["Montréal, QC, CA"]}]
        return httpx.Response(200, json={"data": {"count": len(rows), "positions": rows}})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        out = eightfold.fetch_eightfold_board(client, CO)
    assert "stagiaire" in queries
    assert len(out) == 1
    assert out[0]["locations"] == ["Montréal, QC, Canada"]
    assert evaluate_locations(out[0]["locations"])["in_canada"]
