"""The outreach kit must use real, fresh coverage and never invent a destination."""
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
import outreach  # noqa: E402

NOW = datetime(2026, 9, 27, 16, tzinfo=timezone.utc)


def row(i, company, tags=("swe",), state="MA"):
    return {"id": str(i), "title": f"Intern {i}", "company_name": company, "field_tags": list(tags),
            "keys": {state}, "regions": [{"state": state, "loc": f"Boston, {state}"}],
            "first_seen": (NOW - timedelta(days=1)).isoformat(), "posted_at": None,
            "apply_url": f"https://jobs.example/{i}"}


def test_build_selects_covered_major_and_tracked_links(monkeypatch):
    listings = [row(i, f"Employer {i}") for i in range(4)]
    data = {"generated_at": NOW.isoformat(), "listings": listings, "baseline": "2026-09-18",
            "majors": [{"name": "Computer Science", "tags": ["swe"], "level": "undergrad"},
                       {"name": "Music", "tags": ["music"], "level": "undergrad"}]}
    monkeypatch.setattr(outreach.audience, "PRIMARY", 3)
    kit = outreach.build(data, NOW)
    assert [x["major"] for x in kit["majors"]] == ["Computer Science"]
    major = kit["majors"][0]
    assert major["new"] == 4 and major["open"] == 4
    assert len({r["company"] for r in major["roles"]}) == 3
    for medium in ("email", "community"):
        url = urlparse(major[f"{medium}_url"])
        query = parse_qs(url.query)
        assert url.path == "/" and query["field"] == ["swe"]
        assert query["utm_source"] == ["campus_partner"]
        assert query["utm_medium"] == [medium]
    draft = outreach.render(kit)
    assert "No messages have been sent" in draft
    assert "Employer 0" in draft


def test_stale_or_thin_data_produces_no_claims(monkeypatch):
    data = {"generated_at": (NOW - timedelta(days=3)).isoformat(), "listings": [], "majors": []}
    kit = outreach.build(data, NOW)
    assert kit["status"] == "stale" and kit["majors"] == []
    assert "Refresh the ingest first" in outreach.render(kit)
    data["generated_at"] = NOW.isoformat()
    assert outreach.build(data, NOW)["majors"] == []


def test_examples_choose_a_region_in_the_target_area():
    job = row(1, "Example", state="MA")
    job["keys"].add("IL")
    job["regions"].insert(0, {"state": "IL", "loc": "Champaign, IL"})
    assert outreach.place_nearby(job).startswith("Boston, MA")
