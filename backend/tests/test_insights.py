"""Requirement / eligibility extraction from job descriptions, plus the score breakdown."""
import re
from datetime import date, datetime, timezone
from internscout.insights import extract, extract_skills, PATTERNS
from internscout.score import score_parts, score_listing, W

JD = """About the role
You will build trading tools in Python and React.
Requirements
Currently pursuing a Bachelor's degree, graduating between December 2027 and June 2028
Experience with C++ or Java
Strong knowledge of data structures and algorithms
Minimum GPA of 3.5
Preferred qualifications
Familiarity with Kubernetes and AWS
Knowledge of SQL is a plus
Applicants must be U.S. citizens due to ITAR. This role requires the ability to obtain a security clearance.
We are unable to provide visa sponsorship for this position.
Applications are due by March 15, 2027.
We do not discriminate on the basis of race, citizenship status, or veteran status."""


def test_skills_split_required_and_preferred():
    s = {x["name"]: x["level"] for x in extract_skills(JD)}
    assert s["C++"] == "required" and s["Java"] == "required"
    assert s["Python"] == "required" and s["React"] == "required"
    assert s["Data structures & algorithms"] == "required"
    assert s["Kubernetes"] == "preferred" and s["AWS"] == "preferred" and s["SQL"] == "preferred"
    assert "JavaScript" not in s and "R" not in s


def test_skill_boundaries():
    names = lambda t: {x["name"] for x in extract_skills(t)}
    assert "C#" in names("Experience with C# and .NET")
    assert "Java" not in names("Strong JavaScript skills")
    assert "React" not in names("Ability to react to changing priorities")
    assert "Go" not in names("Go above and beyond")
    assert "R" in names("Proficiency in Python or R")


def test_eligibility():
    x = extract(JD, today=date(2026, 9, 14))
    assert x["grad_years"] == [2027, 2028]
    assert x["citizenship"] == "citizen"
    assert x["clearance"] is True
    assert x["gpa_min"] == 3.5
    assert x["no_sponsorship"] is True
    assert x["deadline"] == "2027-03-15"
    assert "degree_only" not in x


def test_eeo_boilerplate_is_not_a_restriction():
    x = extract("We welcome all applicants without regard to U.S. citizenship status or national origin.")
    assert "citizenship" not in x
    x = extract("Must be a U.S. citizen or permanent resident.")
    assert x["citizenship"] == "citizen_or_pr"


def test_phd_only_and_standing():
    assert extract("Open to PhD students in machine learning.")["degree_only"] == "phd"
    assert "degree_only" not in extract("Open to undergraduate and PhD students.")
    assert extract("For rising juniors or seniors.")["class_standing"] == ["junior"]
    assert extract("Open to sophomore or junior students")["class_standing"] == ["junior", "sophomore"]


def test_deadline_without_year_rolls_forward():
    assert extract("Apply by Feb 1.", today=date(2026, 9, 14))["deadline"] == "2027-02-01"
    assert extract("Deadline: 10/31/2026")["deadline"] == "2026-10-31"


def test_patterns_are_js_compatible():
    for p in PATTERNS.values():
        assert "(?i" not in p and "\\Z" not in p and "(?P<" not in p
        re.compile(p)


def test_score_parts_sum_to_total():
    kw = dict(field_tags=["swe"], geo={"in_city": True}, first_seen=datetime.now(timezone.utc),
              status="open", is_quant_target=False, sources=["greenhouse"])
    parts = score_parts(**kw)
    assert set(parts) == set(W)
    assert parts["location"] == W["location"]
    assert abs(sum(parts.values()) - score_listing(**kw)) < 0.2


def test_gpa_scale_is_not_the_minimum():
    assert extract("Must have at least a 3.0 cumulative GPA, if on a 4.0 scale")["gpa_min"] == 3.0
    assert extract("GPA of 3.2/4.0 or higher")["gpa_min"] == 3.2
    assert extract("3.5 out of 4.0 GPA preferred")["gpa_min"] == 3.5


def test_agile_needs_a_practice_not_a_vibe():
    names = lambda t: {x["name"] for x in extract_skills(t)}
    assert "Agile" not in names("Join a forward-thinking, agile team")
    assert "Agile" in names("Experience with agile development and Jira")
