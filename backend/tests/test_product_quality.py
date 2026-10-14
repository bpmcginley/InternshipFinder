"""Product regressions: do not hide suitable roles through eligibility/term/geo errors."""
import pytest

from internscout.classify import years_of
from internscout.export_static import shard_keys
from internscout.insights import extract
from internscout.normalize import normalize
from internscout.region import evaluate_locations


@pytest.mark.parametrize("degree", ["BS/MS", "BA/MS", "B.S./M.S."])
def test_combined_degrees_include_undergraduates(degree):
    assert years_of(f"2027 Summer Intern, {degree}, Software Engineer") == [
        "first_year", "sophomore", "junior", "senior", "masters"]


@pytest.mark.parametrize("text,expected", [
    ("Open to junior and senior students", ["junior", "senior"]),
    ("Seeking junior or senior undergraduates", ["junior", "senior"]),
    ("Open to freshman or sophomore students", ["freshman", "sophomore"]),
    ("Open to sophomore, junior, or senior standing", ["junior", "senior", "sophomore"]),
    ("For rising juniors or seniors", ["junior", "senior"]),
    ("Open to first-year and sophomore students", ["freshman", "sophomore"]),
])
def test_every_alternative_class_year_is_retained(text, expected):
    insights = extract(text)
    assert insights["class_standing"] == expected
    assert set(years_of("Intern", insights)) == {
        "first_year" if year == "freshman" else year for year in expected}


def test_senior_job_title_is_not_student_class_standing():
    assert "class_standing" not in extract("Work with a senior software engineer and junior analyst.")
    assert years_of("Software Intern, Jackson, MS") == []
    assert years_of("Software Intern using MS Office") == []


@pytest.mark.parametrize("url,term", [
    ("https://example.com/careers/2026/09/intern", "Summer 2027"),
    ("https://example.com/jobs/2025/apply", "Summer 2027"),
    ("https://example.com/jobs/summer-2028-intern", "Summer 2028"),
    ("https://example.com/jobs/2028_summer_intern", "Summer 2028"),
])
def test_url_dates_do_not_override_a_real_term(url, term):
    listing = normalize({"title": "Software Engineering Intern", "company_name": "Example",
                         "locations": ["Boston, MA"], "source": "greenhouse", "apply_url": url,
                         "description": "Summer 2027 internship", "active": True})
    assert listing is not None
    assert listing["term"] == term


def test_country_and_work_mode_suffixes_do_not_create_unrestricted_locations():
    canada = evaluate_locations(["Toronto, ON, Canada"])
    assert len(canada["regions"]) == 1
    assert canada["regions"][0]["state"] == "ON"
    assert set(shard_keys(canada)) == {"ON"}
    texas = evaluate_locations(["Austin, TX, Remote"])
    assert len(texas["regions"]) == 1
    assert texas["is_remote"]
    assert set(shard_keys(texas)) == {"TX"}
    multiple = evaluate_locations(["Cambridge, MA, Arlington, VA"])
    assert {region["state"] for region in multiple["regions"]} == {"MA", "VA"}


@pytest.mark.parametrize("location,kind", [
    ("US-NY-NEW YORK-B1 ~ 55 Water St", "nyc_metro"),
    ("USA NY New York 100 Broadway", "nyc_metro"),
    ("US, Massachusetts, Boston", "new_england"),
])
def test_ats_site_codes_have_the_same_geo_as_the_displayed_city(location, kind):
    geo = evaluate_locations([location])
    assert geo["in_city"]
    assert geo["within_radius"]
    assert geo["regions"][0]["kind"] == kind
