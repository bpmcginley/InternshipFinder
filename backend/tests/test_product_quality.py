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


# PR #94 follow-up. A US town that shares a foreign city's name, with a work mode after the state, kept
# its state on main and lost every region once the suffix stayed attached to the town.
@pytest.mark.parametrize("location,state", [
    ("Berlin, CT, Hybrid", "CT"), ("Vienna, VA, Remote", "VA"), ("Dublin, OH, Remote", "OH"),
    ("Dublin, CA, Hybrid", "CA"), ("Paris, TX, Remote", "TX"), ("Vancouver, WA, Remote", "WA"),
    ("London, KY, Remote", "KY"), ("Ontario, CA, Remote", "CA"), ("Warsaw, IN, Remote", "IN"),
    ("Milan, IL, Onsite", "IL"),
])
def test_us_namesake_town_with_a_work_mode_keeps_its_state(location, state):
    geo = evaluate_locations([location])
    assert [(r["loc"], r["state"]) for r in geo["regions"]] == [(location, state)]
    assert set(shard_keys(geo)) == {state}
    assert not geo["in_canada"]
    assert geo["is_remote"] == ("Remote" in location)


@pytest.mark.parametrize("location,regions", [
    ("Toronto, ON, Canada", [("Toronto, ON, Canada", "ON")]),
    ("Seattle, WA, Remote, Boston, MA", [("Seattle, WA, Remote", "WA"), ("Boston, MA", "MA")]),
    ("New York, NY, Remote, Toronto, ON, Canada", [("New York, NY, Remote", "NY"), ("Toronto, ON, Canada", "ON")]),
    ("Arlington, VA, Hybrid, Seattle, WA", [("Arlington, VA, Hybrid", "VA"), ("Seattle, WA", "WA")]),
    ("Toronto, ON, Canada, Boston, MA", [("Toronto, ON, Canada", "ON"), ("Boston, MA", "MA")]),
    ("Ottawa, ON, Canada, Remote", [("Ottawa, ON, Canada, Remote", "ON")]),
])
def test_a_suffix_mid_string_does_not_swallow_the_next_city(location, regions):
    geo = evaluate_locations([location])
    assert [(r["loc"], r["state"]) for r in geo["regions"]] == regions
    # no stray country-only "Canada" region beside the province
    assert all(r["state"] for r in geo["regions"])


@pytest.mark.parametrize("location", ["Berlin, DE, Remote", "London, UK, Hybrid", "Pune, IN, Remote"])
def test_foreign_cities_with_a_work_mode_stay_out(location):
    assert evaluate_locations([location])["regions"] == []


def _term(title, url, description=""):
    listing = normalize({"title": title, "company_name": "Example", "locations": ["Boston, MA"],
                         "source": "workday", "apply_url": url, "description": description,
                         "active": True, "posted_at": "2026-10-01"})
    assert listing is not None
    return listing["term"]


_NEXT = __import__("datetime").datetime.now().year + 1


# The URL is the last place a season or a year is read from, and only its job part: a Workday site
# segment (Spring-Texas, Spring-House-Pennsylvania) and requisition ids are not the term.
@pytest.mark.parametrize("title,url,description,term", [
    ("Engineering Intern", "https://lseg.wd3.myworkdayjobs.com/Graduate_Careers/job/New-York-City-United-States/"
     "Engineering-Summer-Internship-Programme_R0123569", "", "Summer"),
    ("Software Engineering Intern", "https://x.wd5.myworkdayjobs.com/c/job/Boston-MA/Summer-Intern---Data_R1", "", "Summer"),
    ("Summer Analyst", f"https://x.wd1.myworkdayjobs.com/c/job/Charlotte-NC/XMLNAME-{_NEXT}-Capital-Markets-Summer-Analyst"
     "_2026-0013035", "", f"Summer {_NEXT}"),
    ("Technology Intern", "https://careers.fiserv.com/us/en/job/FFFYJUSR10390344EXTERNALENUS/Technology-Summer-Intern"
     "?jr_id=69e6ab5e3aa0c4796439589b", "", "Summer"),
    ("Machine Learning Intern", "https://www.pinterestcareers.com/jobs/7255640/phd-fall-machine-learning-intern/", "", "Fall"),
    ("Software Engineering Co-op", "https://x.com/jobs/co-op-fall-2026winter-2027", "", "Fall 2026"),
    ("Software Engineering Intern", "https://x.wd5.myworkdayjobs.com/c/job/Boston-MA/Summer-2027_JR-45705", "", "Summer 2027"),
    # a season the description writes still comes before the URL's lone season
    ("Software Engineering Intern", "https://example.com/jobs/summer-intern", "Fall internship", "Fall"),
    # a URL date does not override the description's term
    ("Software Engineering Intern", "https://example.com/careers/2026/09/intern", "Summer 2027 internship", "Summer 2027"),
    # a lone year far from now is not the term
    ("Summer Intern", "https://example.com/jobs/intern-2031", "", "Summer"),
    # Workday site segments and requisition ids are not the term
    ("Hardware Engineer Intern", "https://hpe.wd5.myworkdayjobs.com/jobsathpe/job/Spring-Texas-United-States-of-America/"
     "Hardware-Engineering-Intern_1213408", "", None),
    ("TDS Proteins CEAS Co-Op", "https://jj.wd5.myworkdayjobs.com/JJ/job/Spring-House-Pennsylvania-United-States-of-America/"
     "TDS-Proteins-CEAS-Co-Op_R-104194", "", None),
    ("Pharmacy Intern", "https://cvshealth.wd1.myworkdayjobs.com/CVS_Health_Careers/job/FL---Winter-Garden/"
     "Pharmacy-Intern_R1072695", "", None),
    ("Fall Co-op", "https://gorbel.wd501.myworkdayjobs.com/c/job/USA-New-York-Victor/Mechanical-Engineering-Co-Op_REQ-2026-2284-1",
     "", "Fall"),
])
def test_apply_url_supplies_a_term_only_as_a_last_resort(title, url, description, term):
    assert _term(title, url, description) == term


def test_lone_url_year_is_this_year_or_next():
    from datetime import datetime
    from internscout.normalize import lone_url_year, url_job_words
    today = datetime(2026, 10, 14)
    assert lone_url_year(url_job_words("https://x.com/jobs/intern-2027"), today) == 2027
    assert lone_url_year(url_job_words("https://x.com/jobs/intern-2026"), today) == 2026
    assert lone_url_year(url_job_words("https://x.com/jobs/intern-2025"), today) is None
    assert lone_url_year(url_job_words("https://x.com/jobs/intern-2028"), today) is None
    assert lone_url_year(url_job_words("https://x.com/careers/2026/09/intern"), today) is None
    assert lone_url_year(url_job_words("https://jobs.lever.co/x/2026abcd-1234-4321-aaaa-123456789abc"), today) is None


# PR #94 review, listing parsing: phrases that named a class year without limiting to it.
@pytest.mark.parametrize("text,expected", [
    # staff, not students
    ("You will present to current senior leadership.", None),
    ("Work alongside incoming junior analysts.", None),
    # a role that serves students
    ("Ambassadors are student mentors who can help first-year students settle in.", None),
    ("You will facilitate workshops and sessions dedicated to first-year students.", None),
    # completed a year: the years after it
    ("All applicants must have completed their Freshman year of college.", ["junior", "senior", "sophomore"]),
    ("Must have completed junior year of a bachelor's program.", ["senior"]),
    ("Completed Sophomore year of college.", ["junior", "senior"]),
    ("Must have completed their first year.", ["junior", "senior", "sophomore"]),
    ("Completed junior-level coursework.", None),
    # at least / or higher: that year and up
    ("Priority goes to students that are at least current sophomores.", ["junior", "senior", "sophomore"]),
    ("Must have at least a sophomore standing.", ["junior", "senior", "sophomore"]),
    ("Junior or higher in an engineering major.", ["junior", "senior"]),
    ("Rising sophomore or higher.", ["junior", "senior", "sophomore"]),
    ("Have reached junior standing or higher.", ["junior", "senior"]),
    ("A technical discipline with a preference for a standing of a sophomore or higher.", None),
    # still read as before
    ("Must be an incoming Junior or Senior level student.", ["junior", "senior"]),
    ("Open to current juniors.", ["junior"]),
    ("Open to first-year and sophomore students", ["freshman", "sophomore"]),
    ("Must be a rising sophomore, junior, or senior.", ["junior", "senior", "sophomore"]),
])
def test_class_year_mentions_that_are_not_a_single_year_limit(text, expected):
    assert extract(text).get("class_standing") == expected


@pytest.mark.parametrize("loc,states", [
    ("Seattle, WA, Remote, Boston, MA", ["WA", "MA"]),
    ("Seattle, WA, Hybrid, Boston, MA, Hybrid, Austin, TX", ["WA", "MA", "TX"]),
    ("Toronto, ON, Canada, Austin, TX", ["ON", "TX"]),
    ("Seattle, WA, USA, Boston, MA", ["WA", "MA"]),
    ("Seattle, WA, United States, Boston, MA, United States", ["WA", "MA"]),
    ("Boston, MA, United States", ["MA"]),
])
def test_a_suffix_mid_location_keeps_the_next_city(loc, states):
    assert [r["state"] for r in evaluate_locations([loc])["regions"]] == states
