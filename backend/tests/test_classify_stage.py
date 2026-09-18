"""Stage, class-year, new field tags, terms and pay: the all-majors tagging."""
from datetime import date
from internscout.classify import classify, stage_of, years_of, is_internship, ALL_FIELDS
from internscout.config import open_terms
from internscout.insights import extract
from internscout.majors import UNDERGRAD, GRADUATE, majors_export
from internscout.normalize import parse_term_from_text


def test_stages():
    assert stage_of("Python Software Engineer Co-op") == ["co_op"]
    assert stage_of("Campus Quantitative Trader (Intern)") == ["internship"]
    assert stage_of("Summer Undergraduate Research Fellowship (SURF)") == ["research", "fellowship"]
    assert stage_of("REU Site: Computational Biology") == ["research"]
    assert stage_of("Undergraduate Research Assistant, Chemistry Lab") == ["research"]
    assert stage_of("Possibilities Summit - Sophomore") == ["early_insight"]
    assert "early_insight" in stage_of("Freshman Discovery Program 2027")
    assert stage_of("Part-Time Student Assistant, Marketing") == ["part_time"]
    assert stage_of("Electrician Apprentice") == ["apprenticeship"]
    assert stage_of("Social Work Practicum") == ["internship"]
    assert stage_of("Student Trainee (Economics)") == ["internship"]
    assert stage_of("Nursing Student Extern") == ["internship"]
    assert stage_of("Data Analyst", "Internship") == ["internship"]


def test_not_student_roles():
    for t in ("Software Engineer, New Grad", "2027 Early Career Software Engineer", "Forward Deployed AI Engineer - Campus",
              "Management Trainee", "Postdoctoral Fellow", "Senior Research Fellow", "Internal Audit Analyst",
              "Entry-Level Analyst Program", "Senior Software Engineer"):
        assert stage_of(t) == [], t
    assert not is_internship("Software Engineer (New Grad)")
    assert is_internship("New Grad / Intern Software Engineer")   # explicit intern wins
    assert stage_of("Early Career Mechanical Engineering- Summer 2027") == ["internship"]
    assert "finance" in classify("2027 Corporate Banking Summer Analyst")
    assert "operations" in classify("PGIM: 2027 Operations, Internship Program")


def test_runs_the_programme():
    """The staff job that administers a programme is not a place on it."""
    for t in ("Assistant/Associate Coop Coordinator",      # Northeastern posts this one
              "Practicum Coordinator II for Nursing",      # and it was our only 'nursing' listing
              "Manager, Internship Programs", "Internship Program Manager", "Intern Coordinator",
              "Co-op Program Director", "Internship Supervisor", "Internship Recruiter",
              "Fellowship Coordinator", "Intern and Volunteer Supervisor",
              "Advisor, Co-op and Experiential Learning", "Intern & Special Programs Coordinator",
              # "<staff noun> of|for" only counts ahead of the student word, hence both of these
              "Coordinator of Student Internships", "Director of Public Sector Internships"):
        assert stage_of(t) == [], t

    # ...but the same words describe real student roles, and then the student word heads the title:
    for t in ("Program Coordinator Intern",                 # at the end
              "Research Coordinator Intern (Summer 2027)",  # or before a separator
              "Intern, Program Coordination", "Co-op, Advisor Technology Platform",
              "Volunteer/Intern: Content Marketing Manager",
              "Internship \u2014 Business Coordinator (Year-Round)",
              "Summer 2027 Internship: Learning and Development Programs Administrator",
              # neither word takes a separator, so the later one wins
              "Quality Coordinator Intern Summer 2027, Idaho",
              # "for" here belongs to the product, not to a programme being administered
              "Summer Intern - Product Manager for Allegion Home",
              # work-study is a student job whatever the role is called
              "Federal Work Study possible: Art@Work Graduate Coordinator"):
        assert is_internship(t), t


def test_student_without_the_word_intern():
    """Not every student posting says "intern"; some just say "student"."""
    # Aramco Americas posts seventeen of these and nothing else
    assert stage_of("Finance Department - 2027 Summer Student Program") == ["internship"]
    assert is_internship("Summer Student, Research and Development (Boston Research Center)")
    # the role noun on its own, at the end of the title or before a separator
    assert stage_of("Physical Design Student") == ["internship"]
    assert is_internship("Software Engineering Student - Summer 2027")

    # a Werkstudent is a part-time job for someone enrolled, so it is part_time and not an internship
    assert stage_of("Working Student - Brand Communications") == ["part_time"]
    assert stage_of("Software Developer, Working Student") == ["part_time"]
    # unless the posting says both, and then it is both
    assert stage_of("Working Student / Intern Accounting (f/m/d)") == ["internship", "part_time"]

    # plural is left out on purpose: a title ending in "Students" is usually a job serving them
    assert not is_internship("Senior Product Manager, GPTZero - Students")
    assert not is_internship("Senior Product Manager (Student Safety)")
    # "student" mid-title is not the role, and these stay out on their own merits
    assert not is_internship("Student Success Manager")
    assert not is_internship("Director of Student Financial Services")


def test_new_field_tags():
    cases = {
        "Nursing Student Extern": "nursing", "Public Health Intern": "public_health",
        "Clinical Research Coordinator Intern": "clinical_research", "Undergraduate Lab Research Assistant": "lab_research",
        "Museum Collections Intern": "museums", "Editorial Intern": "publishing", "Journalism Intern": "journalism",
        "Film Production Intern": "film", "Music Business Intern": "music", "Stage Management Intern": "theater",
        "Library Intern": "library", "Urban Planning Intern": "urban_planning", "Sustainability Intern": "sustainability",
        "Supply Chain Intern": "supply_chain", "Entrepreneurship Program Intern": "entrepreneurship",
        "Communications Intern": "communications",
    }
    for title, tag in cases.items():
        assert tag in classify(title), (title, classify(title))
    assert classify("Marketing Intern") == ["marketing"]


def test_years():
    assert years_of("2027 Internship - Quantitative Researcher (PhD)") == ["phd"]
    assert years_of("Campus Quantitative Researcher, UG/MS (Intern)") == ["first_year", "sophomore", "junior", "senior", "masters"]
    assert years_of("Summer Intern", {"class_standing": ["junior"]}) == ["junior"]
    assert years_of("2027 Summer Intern - Technology Group - Sophomore") == ["sophomore"]
    assert years_of("Software Engineer Intern") == []
    assert years_of("Marketing Intern, Jackson, MS") == []


def test_terms():
    assert parse_term_from_text("Co-op (Fall 2026)") == ("Fall", 2026)
    assert parse_term_from_text("Research Intern (Year-Round)") == ("Year-round", None)
    assert parse_term_from_text("Autumn 2026 Intern")[0] == "Fall"
    assert parse_term_from_text("Intern. Experience with Spring Boot. 2027")[0] is None
    t = open_terms(date(2026, 9, 14))
    assert ("Fall", 2026) in t and ("Summer", 2027) in t and ("Spring", 2027) in t
    assert ("Summer", 2026) not in t


def test_pay():
    assert extract("This is an unpaid internship for academic credit.")["pay"] == "unpaid"
    assert extract("Fellows receive a $5,000 stipend.")["pay"] == "stipend"
    assert extract("Pay range: $20-$25 per hour")["pay"] == "paid"
    assert "pay" not in extract("Great team, flexible schedule, paid time off.")


def test_majors_use_known_tags():
    known = set(ALL_FIELDS)
    for name, (tags, related) in {**UNDERGRAD, **GRADUATE}.items():
        assert set(tags) <= known and set(related) <= known, name
    ex = majors_export()
    assert len(ex["majors"]) == len(UNDERGRAD) + len(GRADUATE) and "internship" in ex["stages"]
