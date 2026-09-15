"""UMass Amherst majors -> field tags, so a student picks a major instead of our tag vocabulary.

"tags" are direct matches (full field points); "related" are adjacent fields (partial points).
The list follows the UMass Amherst undergraduate catalog as of Fall 2026 plus common graduate
programs; students with an unlisted or undeclared major pick fields directly.
"""
from __future__ import annotations
from .classify import ALL_FIELDS, STAGES, YEARS

LANG_RELATED = ("education", "government", "publishing")

# name: (tags, related)
UNDERGRAD: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    # Isenberg School of Management
    "Accounting": (("accounting",), ("finance", "consulting")),
    "Finance": (("finance",), ("accounting", "consulting", "insurance", "real_estate", "quant")),
    "Hospitality and Tourism Management": (("hospitality",), ("marketing", "operations", "sports")),
    "Management": (("consulting", "operations", "hr"), ("entrepreneurship", "sales", "pm")),
    "Marketing": (("marketing",), ("sales", "communications", "retail", "design")),
    "Operations and Information Management": (("operations", "supply_chain", "data"), ("consulting", "pm", "industrial")),
    "Sport Management": (("sports",), ("marketing", "sales", "hospitality")),
    # Engineering
    "Biomedical Engineering": (("biomedical",), ("biology", "health", "mechanical", "clinical_research")),
    "Chemical Engineering": (("chemical",), ("materials", "environmental", "biology", "chemistry")),
    "Civil Engineering": (("civil",), ("environmental", "urban_planning", "architecture")),
    "Computer Engineering": (("hardware", "swe"), ("electrical", "security", "ml")),
    "Electrical Engineering": (("electrical", "hardware"), ("swe", "physics", "aerospace")),
    "Environmental Engineering": (("environmental", "civil"), ("sustainability", "chemical")),
    "Industrial Engineering": (("industrial", "supply_chain", "operations"), ("data", "consulting")),
    "Mechanical Engineering": (("mechanical",), ("aerospace", "hardware", "materials", "industrial")),
    # Information and Computer Sciences
    "Computer Science": (("swe",), ("ml", "data", "security", "quant", "pm")),
    "Informatics": (("data", "swe"), ("design", "pm", "ml", "security")),
    # Natural Sciences
    "Animal Science": (("agriculture", "biology"), ("lab_research",)),
    "Astronomy": (("physics",), ("data", "aerospace", "lab_research")),
    "Biochemistry and Molecular Biology": (("biology", "chemistry", "lab_research"), ("clinical_research", "health")),
    "Biology": (("biology", "lab_research"), ("health", "clinical_research", "environmental")),
    "Chemistry": (("chemistry", "lab_research"), ("chemical", "materials", "biology")),
    "Environmental Science": (("environmental", "sustainability"), ("agriculture", "government", "lab_research")),
    "Food Science": (("agriculture", "chemistry"), ("health", "retail", "lab_research")),
    "Geography": (("urban_planning", "environmental"), ("data", "government")),
    "Geology": (("environmental",), ("sustainability", "civil", "lab_research")),
    "Mathematics": (("math",), ("quant", "data", "finance", "insurance")),
    "Microbiology": (("biology", "lab_research"), ("health", "clinical_research")),
    "Natural Resources Conservation": (("environmental", "sustainability", "agriculture"), ("government", "nonprofit")),
    "Neuroscience": (("biology", "psychology", "lab_research"), ("clinical_research", "health")),
    "Physics": (("physics",), ("quant", "hardware", "data", "aerospace")),
    "Plant, Soil and Insect Sciences": (("agriculture", "biology"), ("sustainability", "lab_research")),
    "Psychology": (("psychology",), ("health", "social_work", "education", "data", "hr")),
    "Statistics and Data Science": (("data", "math"), ("ml", "quant", "insurance")),
    "Sustainable Food and Farming": (("agriculture", "sustainability"), ("nonprofit",)),
    "Building and Construction Technology": (("civil", "architecture"), ("real_estate", "sustainability")),
    "Landscape Architecture": (("architecture", "urban_planning"), ("sustainability", "design")),
    # Public Health and Health Sciences / Nursing
    "Communication Disorders": (("health",), ("education", "psychology", "clinical_research")),
    "Kinesiology": (("health", "sports"), ("clinical_research", "biomedical")),
    "Nursing": (("nursing", "health"), ("clinical_research", "public_health")),
    "Nutrition": (("health", "public_health"), ("agriculture", "clinical_research")),
    "Public Health Sciences": (("public_health", "health"), ("clinical_research", "government", "nonprofit", "data")),
    # Social and Behavioral Sciences
    "Anthropology": (("nonprofit", "museums"), ("public_health", "government")),
    "Communication": (("communications", "media"), ("marketing", "film", "journalism")),
    "Economics": (("economics",), ("finance", "consulting", "government", "data")),
    "Resource Economics": (("economics",), ("sustainability", "agriculture", "finance")),
    "Journalism": (("journalism", "media"), ("communications", "publishing")),
    "Legal Studies": (("law",), ("government", "nonprofit")),
    "Political Science": (("government", "law"), ("nonprofit", "economics", "communications")),
    "Public Policy": (("government", "economics"), ("nonprofit", "urban_planning", "public_health")),
    "Sociology": (("social_work", "nonprofit"), ("government", "data", "hr")),
    "Social Thought and Political Economy": (("nonprofit", "government"), ("economics",)),
    "Sustainable Community Development": (("urban_planning", "sustainability"), ("nonprofit", "government")),
    "Women, Gender, Sexuality Studies": (("nonprofit", "social_work"), ("government", "public_health")),
    "Afro-American Studies": (("nonprofit", "education"), ("museums", "government")),
    # Humanities and Fine Arts
    "Architecture": (("architecture",), ("design", "civil", "urban_planning")),
    "Art (Studio)": (("arts", "design"), ("museums", "media")),
    "Art History": (("arts", "museums"), ("publishing", "education")),
    "Classics": (("museums", "education"), ("library", "publishing")),
    "Comparative Literature": (("publishing", "languages"), ("education",)),
    "Dance": (("theater", "arts"), ("education",)),
    "English": (("publishing", "media"), ("communications", "education", "journalism", "library")),
    "History": (("museums", "education"), ("library", "government", "law", "publishing")),
    "Judaic Studies": (("nonprofit", "education"), ("museums",)),
    "Linguistics": (("languages",), ("ml", "education", "psychology")),
    "Middle Eastern Studies": (("government", "languages"), ("nonprofit",)),
    "Music": (("music", "arts"), ("education", "media")),
    "Philosophy": (("law",), ("government", "education")),
    "Theater": (("theater", "arts"), ("film", "media")),
    "Chinese Language and Literature": (("languages",), LANG_RELATED),
    "French and Francophone Studies": (("languages",), LANG_RELATED),
    "German and Scandinavian Studies": (("languages",), LANG_RELATED),
    "Italian Studies": (("languages",), LANG_RELATED),
    "Japanese Language and Literature": (("languages",), LANG_RELATED),
    "Portuguese and Brazilian Studies": (("languages",), LANG_RELATED),
    "Russian and East European Studies": (("languages",), LANG_RELATED),
    "Spanish and Latin American Studies": (("languages",), LANG_RELATED),
    # Education / other
    "Education": (("education",), ("nonprofit", "psychology", "social_work")),
    "Individual Concentration (BDIC)": ((), ()),
    "Exploratory / Undeclared": ((), ()),
}

GRADUATE: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "MBA": (("consulting", "finance", "marketing"), ("pm", "operations", "entrepreneurship")),
    "MS Accounting": (("accounting",), ("finance",)),
    "MS Computer Science": (("swe", "ml"), ("data", "security")),
    "MS Data Science / Statistics": (("data", "math"), ("ml", "quant")),
    "MS Engineering (any)": (("mechanical", "electrical", "civil", "industrial"), ("hardware", "materials")),
    "Master of Public Health": (("public_health", "health"), ("clinical_research", "government")),
    "Master of Public Policy": (("government", "economics"), ("nonprofit", "urban_planning")),
    "Master of Education": (("education",), ("nonprofit", "psychology")),
    "MS Hospitality and Tourism": (("hospitality",), ("marketing",)),
    "MS Sport Management": (("sports",), ("marketing", "sales")),
    "MFA / MA Arts and Humanities": (("arts", "publishing"), ("museums", "education")),
    "PhD Sciences": (("lab_research",), ("biology", "chemistry", "physics")),
}


def majors_export() -> dict:
    """What the dashboard needs for the profile picker: majors, the tag and stage vocabularies."""
    rows = [{"name": n, "tags": list(t), "related": list(r), "level": "undergrad"} for n, (t, r) in UNDERGRAD.items()]
    rows += [{"name": n, "tags": list(t), "related": list(r), "level": "grad"} for n, (t, r) in GRADUATE.items()]
    return {"majors": rows, "fields": list(ALL_FIELDS), "stages": list(STAGES), "years": list(YEARS)}
