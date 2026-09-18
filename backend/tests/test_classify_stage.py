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


def test_behaviour_analysis_is_psychology():
    # A psychology major's likeliest paid placement is a BCBA fieldwork or behaviour technician
    # post, and not one of these titles contains the word "psychology". Before this rule they
    # classified as 'other' and the coverage report read psychology 0 with Centria Autism's
    # twelve apprenticeships sitting in the data.
    for title in ["Clinical Apprentice - BCBA Fieldwork Program", "Registered Behavior Technician Intern",
                  "Applied Behavior Analysis Intern", "Behavior Analyst Fieldwork Trainee",
                  "RBT Summer Intern", "ABA Therapy Intern"]:
        assert "psychology" in classify(title), (title, classify(title))
    # Analytics about how customers behave is not behaviour analysis.
    assert "psychology" not in classify("Behavioral Analytics Intern")
    assert "psychology" not in classify("Consumer Behavior Research Intern")


def test_language_teaching_is_languages():
    # Every one of these is an open listing the rule used to miss: a languages major is hired to
    # teach English far more often than to translate anything.
    for title in ["WIOA ESL Assistant Instructor Intern", "Work Study Office Aide - English Language Center",
                  "English Language Learning Intern (Fall 2026- UNPAID)", "Localization Intern",
                  "TESOL Practicum Student", "Spanish Language Tutor"]:
        assert "languages" in classify(title), (title, classify(title))
    # And these are the open listings that made the bare word "language" unusable in the rule.
    for title in ["Student Researcher - Large Language Model - Seed", "PhD Intern - Language Intelligence",
                  "Research Fellow - Mechanistic Interpretability", "Speech Language Pathologist (or SLP Intern)"]:
        assert "languages" not in classify(title), (title, classify(title))


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

def test_a_field_word_inside_a_longer_word_is_not_a_match():
    # "Environmental Health & Safety" contains "mental health", and thirteen of the twenty-six
    # psychology listings in one export were EHS roles because of it.
    assert classify("Environmental Health & Safety Intern") == ["environmental"]
    assert classify("Environmental Health and Safety Co-Op") == ["environmental"]
    assert "psychology" in classify("Mental Health Counseling Intern")
    # and "counsel" is a lawyer, while "counseling" and "counselor" are not.
    assert classify("Social Work / Counseling Intern") == ["psychology", "social_work"]
    assert classify("General Counsel Intern") == ["law"]
    # The same fault in six more tags, found by running every rule over all 13,601 exported
    # titles and keeping the matches whose preceding character is a letter.
    assert classify("Underwriting Internship - Summer 2027") == ["insurance"]   # not ...WRITING INTERN
    assert classify("Telecommunications Intern") == ["other"]                   # not tele...COMMUNICATIONS
    assert classify("2027 Fulfillment Intern") == ["other"]                     # not fu...LLM...ent
    assert classify("HCAD Intern- High School") == ["other"]                    # a county appraiser
    assert classify("ShureCloud Marketing Intern") == ["marketing"]             # a product, not a cloud
    assert classify("3D Asset Reconstruction Intern") == ["other"]              # not pre/construction
    # and each of those words still counts when it is a word.
    assert classify("Editorial Writing Intern")[0] == "media"
    assert "communications" in classify("Marketing Communications Intern")
    assert classify("LLMs Inference Intern") == ["ml"]
    assert classify("AutoCAD Design Intern") == ["mechanical"]
    assert classify("Cloud Engineer Intern") == ["swe"]
    assert classify("Preconstruction Intern") == ["civil"]

def test_engineering_is_the_fallback_for_a_title_with_no_discipline():
    # 1,200 listings in one export said "engineering" and nothing a discipline rule could read,
    # so they carried no field tag at all and scored zero for every engineering major.
    assert classify("Engineering Intern") == ["engineering"]
    assert classify("Quality Engineering Intern") == ["engineering"]
    assert classify("Field Engineer Intern") == ["engineering"]
    # Anything more specific wins outright - the generic tag is never a second opinion.
    assert classify("Mechanical Engineering Intern") == ["mechanical"]
    assert classify("Software Engineering Intern") == ["swe"]
    assert classify("Data Engineering Intern") == ["data"]
    assert classify("Sales Engineer Intern") == ["sales"]
    assert "engineering" in ALL_FIELDS


def test_a_posting_that_names_the_store_is_retail():
    # Target posts its store leadership programme once per city, thirty of them in one export,
    # and the retail rule only knew "store operations".
    assert classify("Store Executive Intern (Store Leadership Intern) - Raleigh, NC") == ["retail"]
    assert classify("Stores Executive Internship (Store Leadership Intern) - Omaha, NE") == ["retail"]
    assert "retail" in classify("Store Analytics Intern")
    # and the one title in the export where "Cloud" is a town in Minnesota, not a platform.
    assert classify("Store Executive Intern (Store Leadership Intern) - St. Cloud, MN") == ["retail"]
    assert classify("Cloud Engineer Intern") == ["swe"]


def test_research_stage_reads_the_word_itself():
    # 549 postings said "research" or "researcher" and got nothing but "internship", against 73
    # that the REU/SURF wording caught, so the stage filter could not see the work it is for.
    for title in ("Research Scientist Intern", "Quantitative Researcher Intern",
                  "AI Research Intern - Foundation Models", "Research Assistant Intern",
                  "2027 Formal Methods Researcher Graduate Intern"):
        assert "research" in stage_of(title), title
    # The wordings that never say "research" still work.
    assert stage_of("REU Site: Computational Biology") == ["research"]
    assert "research" in stage_of("Summer Undergraduate Research Fellowship (SURF)")
    # and a posting with no research in it is untouched.
    assert stage_of("Software Engineering Intern") == ["internship"]


def test_business_is_the_fallback_for_a_title_with_no_function():
    # The Isenberg equivalent of the engineering fallback: 111 postings in one export said
    # "business" or "commercial" and named no function a rule could read.
    assert classify("Business Internship") == ["business"]
    assert classify("Business Performance Intern") == ["business"]
    assert classify("Business Management Intern") == ["business"]
    assert classify("2027 Summer Internship - Business Administration") == ["business"]
    assert classify("Intern, Commercial 2027") == ["business"]
    assert classify("Future Leaders Program - MBA Internship") == ["business"]
    # and it steps aside for anything that does name one.
    assert classify("Business Development Intern") == ["sales"]
    assert classify("Business Intelligence Intern") == ["data"]
    assert classify("Business Operations Intern") == ["operations"]
    assert classify("Commercial Real Estate Intern") == ["real_estate"]
    assert classify("Business Analyst Intern") == ["consulting"]
    # The suppression rule covers both fallbacks now, and a title that is only both keeps both.
    assert classify("Business Engineering Intern") == ["engineering", "business"]
    assert "business" in ALL_FIELDS


def test_translational_medicine_is_not_a_translation_job():
    # "translat(or|ion)" had no right edge, so "Translational" matched it, and the two listings the
    # languages tag had in the baseline states were both bench-to-bedside research.
    assert classify("Sr. Data Scientist, Translational Research") == ["data", "clinical_research"]
    assert classify(
        "2027 Future Talent Program - Discovery, Preclinical and Translational Medicine - Intern"
    ) == ["health", "clinical_research"]
    assert classify("Translational Science Intern") == ["clinical_research"]
    # and the words the rule is actually for still read as languages.
    assert classify("Translation Intern") == ["languages"]
    assert classify("Spanish Translator Intern") == ["languages"]
    assert classify("Translations Coordinator Intern") == ["languages"]
    assert classify("Localization Intern") == ["languages"]


def test_ehs_titles_are_environmental_jobs():
    # 24 of these said only "other", which sorts below everything. They are the compliance arm of an
    # environmental team and the major that wants them is environmental science or public health.
    for title in ("EHS Intern", "HSE Intern", "HSE/Safety Intern", "2027 EHS Safety Intern",
                  "EHS Corporate Intern", "2027 Intern- EHS - Williamsport, PA",
                  "EHS (Environment, Health, & Safety) Intern", "Health and Safety Intern",
                  "Health & Safety Intern", "HEALTH AND SAFETY SKILLBRIDGE INTERN",
                  "Environment, Safety and Health Undergraduate Intern - Fall 2026",
                  "Occupational Health & Safety Intern- CO", "Occupational Safety Intern",
                  "Risk Control/Occupational Safety Internship Summer 2027"):
        assert "environmental" in classify(title), title


def test_safety_boilerplate_in_a_description_is_not_an_ehs_job():
    # Every one of these bodies says it, and none of these jobs is an EHS job.
    for title, body in (
        ("Engineering Intern (Oil & Gas Business)", "Our goal is to meet the highest employer "
         "standards by ensuring the health and safety of our employees."),
        ("Operations Intern, Commercial & MarComs", "Assess our boutiques while adhering to company "
                                                    "regulations, and health and safety codes."),
        ("Safety Engineer Intern", "Work with project managers and superintendents in dealing with "
                                   "all health and safety issues on site, at the project level."),
    ):
        assert "environmental" not in classify(title, body), title


def test_a_discipline_is_findable_by_its_own_name():
    # Every major in majors.py was run through classify as "<major> Intern". These five matched
    # nothing, and unlike the other thirty-two there were real titles waiting behind each of them.
    for title, tag in (
        ("Computer Science Intern", "swe"),
        ("Computer Science Internship - Summer 2027", "swe"),
        ("Geology Intern", "environmental"),
        ("Geoscience Summer Intern", "environmental"),
        ("Geophysics Intern", "environmental"),
        ("GIS / Geospatial Analyst Intern", "environmental"),
        ("Geographic Information Systems Intern", "environmental"),
        ("Health Informatics Intern", "data"),
        ("Bioinformatics Intern", "biology"),
        ("Speech Language Pathology Intern", "health"),
        ("Audiology Extern", "health"),
        ("Communication Disorders Intern", "health"),
    ):
        assert tag in classify(title), (title, classify(title))


def test_the_new_discipline_words_do_not_fire_on_a_description():
    # Two of these were written loose first and measured: a bare \bgis\b tagged anything whose body
    # mentioned a GIS layer, and a bare "speech language" tagged "Machine Learning Researcher,
    # Multimodal LLMs" because its body described speech and language models. Both are anchored now.
    assert "environmental" not in classify(
        "Civil Engineering Intern", "You will pull parcel data from our GIS and hand it to design.")
    assert "health" not in classify(
        "Machine Learning Researcher, Multimodal LLMs",
        "Our models work across speech, language and vision.")


def test_a_degree_list_in_a_description_does_not_make_a_job_a_software_job():
    # 202 descriptions say "computer science" and every one of them is a degree requirement. The
    # bare word put a steel internship and an SEO internship into swe, which is the tag the biggest
    # part of the audience sorts by, so it has to lose to a comma, a slash and a preposition.
    for title, body in (
        ("Steel Fabrication Intern",
         "Majors considered include, but are not limited to, the following: Civil Engineering "
         "Mechanical Engineering Computer Science"),
        ("SEO & On-line Marketing Specialist Intern",
         "Perform the SEO and related projects assigned. - BS/BA in Information/Computer Science "
         "and related field."),
        ("Quantitative Researcher Intern",
         "PhD or master's degree in computer science, mathematics, physics, or statistics."),
        ("Optics Intern",
         "For students pursuing a degree in Computer Science or a related technical field."),
    ):
        assert "swe" not in classify(title, body), title


def test_a_postdoc_is_a_postdoc_however_the_employer_spells_it():
    # All five of these were open on the board, and none of them matched, because the rule asked
    # for an optional hyphen and every one of these employers used a space instead.
    for title in ("Post Doctoral Research Fellow",
                  "Post Doc Research Associate - Networking and Distributed Systems Lab",
                  "School of Arts and Communication Post Doc Visiting Research Associate",
                  "Pain Psychology Post Doctoral Fellowship",
                  "Post Bacc Research Assistant"):
        assert stage_of(title) == [], title
        assert stage_of(title.replace(" Doc", "-Doc").replace(" Bacc", "-Bacc")) == [], title
    # A postdoc that calls itself an intern is still a postdoc - it needs a finished PhD - and the
    # hyphenated spelling was already dropped for the same reason.
    assert stage_of("Post Doc Scientist Data Science AI/ML Intern") == []
    # "post" only starts a postdoc when "doc" or "bacc" follows it, so the word itself is safe.
    assert stage_of("Social Media Post Production Intern") == ["internship"]
    assert stage_of("Research Intern") == ["internship", "research"]


def test_titles_that_used_to_land_in_other_now_reach_their_field():
    # Real titles from the open board, every one of them tagged only "other" before.
    for title, tag in (
        ("Operational Risk Intern [2027 Internship Program]", "finance"),
        ("Payment Risk Intern", "finance"),
        ("Health, Safety, & Environment Intern - Summer 2027", "environmental"),
        ("2027 Summer Intern - Global Workplace Safety", "environmental"),
        ("Fire/Life Safety Summer Intern", "environmental"),
        ("Food Safety Intern- Summer 2027", "agriculture"),
        ("Advanced Energy Intern", "sustainability"),
        ("Energy Internship: Summer 2027", "sustainability"),
        ("Quality Intern (Summer 2027)", "operations"),
        ("Controls Intern | Urbandale, IA", "engineering"),
        ("Guidance, Navigation & Controls (GNC) Internship - Spring 2027", "engineering"),
        ("Summer 2027 Internships - CO Water and Transportation", "civil"),
        ("Inbound Transportation Network Internship", "supply_chain"),
        ("Customer Experience Intern", "marketing"),
        ("Customer Insight Intern", "marketing"),
    ):
        assert tag in classify(title), (title, classify(title))


def test_the_rescue_phrases_stay_out_of_boilerplate():
    # Each phrase is tied to a role word because the bare phrase is everywhere in bodies.
    assert "sustainability" not in classify(
        "C&I Sales Intern", "Be part of a supportive, high-energy intern experience.")
    assert "environmental" not in classify(
        "Intern - Operational Support", "Become familiar with the Health, Safety, and Environment culture.")
    assert "finance" not in classify(
        "Software Engineering Intern", "You will help reduce operational risk across our platform.")
    assert "engineering" not in classify("Internal Controls Intern")
    assert "engineering" not in classify("Process Risk and Controls Consulting Intern")


def test_investment_testing_and_rnd_titles_reach_their_field():
    for title, tag in (("Financial Reporting Intern (Spring 2027)", "finance"),
                       ("Wealth and Investment Management Intern", "finance"),
                       ("Investments Intern - Bank Loans", "finance"),
                       ("Financial Due Diligence Intern - Summer 2027", "finance"),
                       ("R&D Intern - Catholyte", "engineering"),
                       ("Reliability Testing and Failure Analysis Intern", "engineering"),
                       ("Design for Test Intern, BS - Summer 2027", "engineering"),
                       ("Military DoD SkillBridge Internship - Maintenance Technician", "engineering"),
                       ("Advanced Packaging Intern", "hardware"),
                       ("Site Reliability Internship - Spring 2027", "swe")):
        assert tag in classify(title), (title, classify(title))
    # the word alone is not enough where it means something else
    assert "finance" not in classify("2027 Platform Internship, Non-Investment (US)")
    assert "finance" not in classify("Community Relations and Social Investments Intern - WI")
    assert "finance" not in classify("Investment Planning Co-Op Engineer - Fall 2027")
    assert "engineering" not in classify("Site Reliability Internship - Spring 2027")


def test_safety_verification_and_design_titles_reach_their_field():
    for title, tag in (("Safety Intern (College 26-27 Season) - Tyson's, VA", "environmental"),
                       ("Process Safety Intern", "environmental"),
                       ("Intern/Co-op - HES&S Safety and Industrial Hygiene (Summer 2027)", "environmental"),
                       ("Design Verification Intern - MS", "hardware"),
                       ("Highway Design Intern - Summer 2027", "civil"),
                       ("Geomatics Technician Apprentice - Survey and Mapping", "civil"),
                       ("Instructional Design Intern", "education"),
                       ("2027 Experience Design Summer Intern", "design")):
        assert tag in classify(title), (title, classify(title))
    for title in ("Functional Safety Intern", "Product Safety Intern", "Food Safety Intern- Summer 2027"):
        assert "environmental" not in classify(title), title
