"""Fetcher parsers against small saved payload shapes (no network)."""
from internscout.sources.greenhouse import parse_greenhouse
from internscout.sources.lever import parse_lever
from internscout.sources.ashby import parse_ashby
from internscout.sources.workday import parse_workday_list, parse_workday_detail, host_of
from internscout.sources.smartrecruiters import parse_smartrecruiters
from internscout.sources.github_lists import _parse

CO = {"name": "Acme", "ats_token": "acme", "is_quant_target": False}


def test_greenhouse():
    items = parse_greenhouse({"jobs": [
        {"id": 1, "title": "Software Engineer Intern", "location": {"name": "Boston, MA"},
         "absolute_url": "https://boards.greenhouse.io/acme/jobs/1", "updated_at": "2026-09-01T00:00:00Z"},
        {"id": 2, "title": "Senior Engineer", "location": {"name": "Boston, MA"}, "absolute_url": "x"},
    ]}, CO)
    assert len(items) == 1 and items[0]["locations"] == ["Boston, MA"] and items[0]["source"] == "greenhouse"


def test_lever():
    items = parse_lever([{"text": "Data Science Intern", "hostedUrl": "https://jobs.lever.co/acme/1",
                          "applyUrl": "https://jobs.lever.co/acme/1/apply", "createdAt": 1767225600000,
                          "categories": {"location": "New York, NY", "allLocations": ["New York, NY", "Boston, MA"],
                                         "commitment": "Internship"},
                          "descriptionPlain": "Build models."}], CO)
    assert items[0]["locations"] == ["New York, NY", "Boston, MA"]
    assert items[0]["apply_url"].endswith("/apply") and items[0]["posted_at"] == 1767225600


def test_ashby():
    items = parse_ashby({"jobs": [
        {"title": "Quant Research Intern", "employmentType": "Intern", "location": "NYC",
         "secondaryLocations": [{"location": "Boston", "address": {"postalAddress": {
             "addressLocality": "Boston", "addressRegion": "Massachusetts"}}}],
         "isRemote": False, "isListed": True, "jobUrl": "https://jobs.ashbyhq.com/acme/1",
         "applyUrl": "https://jobs.ashbyhq.com/acme/1/application", "publishedAt": "2026-09-01T00:00:00Z",
         "descriptionPlain": "Research."},
        {"title": "Intern (hidden)", "isListed": False},
    ]}, CO)
    assert len(items) == 1 and "Boston, Massachusetts" in items[0]["locations"]


def test_workday():
    assert host_of("modernatx|wd1|M_tx") == ("https://modernatx.wd1.myworkdayjobs.com", "modernatx", "M_tx")
    posts = parse_workday_list({"total": 2, "jobPostings": [
        {"title": "Summer 2027 Engineering Intern", "externalPath": "/job/Cambridge/X_R1", "locationsText": "2 Locations"},
        {"title": "Internal Audit Manager", "externalPath": "/job/y", "locationsText": "Boston, MA"},
    ]})
    assert [p["title"] for p in posts] == ["Summer 2027 Engineering Intern"]
    locs, desc = parse_workday_detail({"jobPostingInfo": {
        "location": "Cambridge, MA", "additionalLocations": ["Norwood, MA"], "jobDescription": "<p>Hi &amp; bye</p>"}})
    assert locs == ["Cambridge, MA", "Norwood, MA"] and desc == "Hi & bye"


def test_smartrecruiters():
    items = parse_smartrecruiters({"totalFound": 2, "content": [
        {"id": "7", "name": "Marketing Intern", "releasedDate": "2026-09-01T00:00:00Z",
         "location": {"city": "Providence", "region": "RI", "country": "us", "remote": False}},
        {"id": "8", "name": "Marketing Intern", "location": {"city": "Paris", "country": "fr"}},
    ]}, CO, "Acme")
    assert len(items) == 1 and items[0]["url"] == "https://jobs.smartrecruiters.com/Acme/7"


def test_simplify_terms():
    items = _parse([{"company_name": "A", "title": "SWE Intern", "terms": ["Fall 2026", "Summer 2027"],
                     "locations": ["Boston, MA"], "url": "u", "active": True, "source": "Simplify"}],
                   "simplify", {"Summer": 2027})
    assert (items[0]["season"], items[0]["year"], items[0]["source"]) == ("Summer", 2027, "simplify")
