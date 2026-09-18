"""Field, career-stage and class-year tagging across college disciplines.

Tags are ordered most-specific first; a posting can carry several. Anything that
matches nothing gets "other" (kept, but scored low) rather than silently dropped,
so coverage never depends on this list being exhaustive.

Only student opportunities are kept: a title needs a stage word (intern, co-op,
fellowship, REU, ...). New-grad and early-career jobs are dropped.
"""
from __future__ import annotations
import re

RULES = [
    # --- computing / quant ---
    ("quant", r"\bquant(itative)?\b|\btrader\b|\btrading\b|market mak|derivativ|\balpha\b|portfolio manag"),
    ("ml", r"\bml\b|machine learning|deep learning|\bnlp\b|computer vision|\bai\b|artificial intelligence|genai|\bllm|research scientist|reinforcement learning"),
    ("data", r"\bdata (scien|engineer|analy|platform)|\banalytics\b|business intelligence|\bbi\b|\betl\b|data warehouse|\bdata\b|informatics"),
    ("security", r"surveillance analyst|detection engineer|privacy engineer|\bsecurity\b|cryptograph|\bappsec\b|penetration|infosec|cyber"),
    ("hardware", r"\bhardware\b|\basic\b|\bfpga\b|embedded|\bvlsi\b|firmware|silicon|chip design|analog|circuit|semiconductor|robotics|mechatronic|advanced packaging"),
    ("swe", r"digital innovation|applied technolog|extended reality|\bxr\b|algorithm develop|digital labs|software|\bswe\b|\bsde\b|developer|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|web dev|mobile|\bios\b|android|platform|infrastructur|devops|\bsre\b|(?<!\bst\. )(?<!\bst )\bcloud|distributed|compiler|graphics|game dev|\bqa\b|quality assurance|test engineer|application develop|technical staff|supercomputing|high performance computing|\bhpc\b|systems engineer|solutions engineer|forward deployed|technology|\bit\b|information technology|(?<![,;/] )(?<!/)(?<!and )(?<!or )(?<!in )(?<!as )(?<!ing )computer scien|site reliability"),
    ("pm", r"\bproduct (intern|specialist|development intern)|digital product|product manage|program manage|technical program|\btpm\b|product owner"),

    # --- engineering (non-software) ---
    ("electrical", r"\belectrical\b|mixed[- ]signal|physical design|\brf\b|power electronics|lighting design|electrical engineer|\bpower systems\b|\bee\b intern"),
    ("mechanical", r"\bmechanical\b|product development engineer|design release|life ?cycle engineer|mechanical engineer|\bme\b intern|thermal|manufactur|\bcad\b|autocad|solidworks|hvac"),
    ("civil", r"\bstructural\b|commissioning|civil engineer|structural engineer|geotechnical|transportation engineer|\bconstruction|preconstruction|water (and|&) transportation|surface transportation( \w+){0,2} (intern|co-?op)|(intern|internships?)\s*[-–,:|]\s*(\w+ ){0,2}surface transportation"),
    ("aerospace", r"aerospace|aeronautic|astronautic|propulsion|avionics|flight (test|science)"),
    ("chemical", r"chemical engineer|process engineer|petroleum|refin"),
    ("materials", r"materials (science|engineer)|metallurg|polymer"),
    ("industrial", r"industrial engineer|systems engineering|operations research|supply chain|logistics|manufacturing engineer"),
    # EHS - environment, health and safety - is the compliance arm of an environmental team, and a
    # student who wants it is an environmental science or public health major. None of its titles say
    # "environmental": 24 of them said only "other", which is the bottom of every ranking.
    #
    # The acronyms are safe anywhere, but the spelled-out phrase is not: "ensuring the health and
    # safety of our employees" is boilerplate in the body of an oil and gas posting, a geology
    # posting and a jewellery boutique posting, so that half is anchored to the role word and only
    # fires on a title like "Environment, Safety and Health Undergraduate Intern".
    ("environmental", r"environmental|sustainab|climate|renewable|energy engineer|water resources|geolog|geoscien|geophysic|geospatial|geographic information system|"
     r"occupational (health (and|&|,) )?safety|\behs\b|\bhse\b|"
     r"(health|safety) ?(and|&|,) ?(safety|health)( \w+){0,2} (intern|co-?op)|health,? safety,? (&|and) environment(al)?\W{0,5}(intern|co-?op)|safety (&|and) environment\W{0,5}(intern|co-?op)|\b(workplace|fire/life|fire (and|&) life|employee health (&|and)) safety( \w+){0,2} (intern|co-?op)|(intern|co-?op)\s*[-–,:|]\s*(\w+ ){0,2}(workplace|employee health (&|and)) safety"),
    ("biomedical", r"biomedical|bioengineer|medical device|clinical engineer"),
    # A posting that says engineering and nothing more specific is still an engineering
    # posting. classify drops this again the moment any other rule matched, so it is the
    # generic case only: "Engineering Intern", "Quality Engineering Intern", "Field Engineer
    # Intern". 1,200 listings in one export, none of which had any field tag before.
    ("engineering", r"\bengineer(ing|s)?\b|(?<!internal )(?<!risk & )(?<!risk and )\bcontrols (intern|technician|engineer|co-?op)|\b(electrical|electronics|process|embedded|manufacturing|flight|vehicle|machine|chassis|powertrain) controls\b|guidance,? navigation,? (&|and) controls|navigation, estimation,? (and|&) controls|\br&d\b|(?<!site )\breliability\b|\btest (automation|technician|equipment|(&|and) validation)|\b(system|ic) test\b|design for test|assembly (and|&) test|\bmaintenance (technician|mechanic|apprentice|intern|engineer)|(aircraft|industrial|nuclear) maintenance"),

    # --- sciences / math / health ---
    ("biology", r"\bbiolog|biotech|genomic|molecular|microbiolog|neuroscience|immunolog|cell (culture|biology)|life sciences|pharma|drug discovery|bioinformatic"),
    ("chemistry", r"bioanalytical|analytical sciences|\bchemist|chemical (research|analysis)|analytical chem|organic chem"),
    ("physics", r"\bphysics\b|photonic|optic|quantum (computing|research|physics)|astronom"),
    ("math", r"\bmathematic|applied math|\bstatistic|biostatistic|actuarial"),
    ("health", r"health systems|value (and|&) access|\bnursing\b|clinical|public health|epidemiolog|healthcare|health care|patient|medical (assistant|research)|hospital|speech[- ]language patholog|speech patholog|audiolog|communication disorders"),
    ("nursing", r"\bnurs(e|es|ing)\b|\bcna\b|\brn\b|patient care (tech|assistant)"),
    ("public_health", r"public health|epidemiolog|community health|global health|health (policy|equity|promotion|education|services research)"),
    # "translational" is bench-to-bedside research, and the boundary added to the languages rule
    # above leaves it with nothing; it belongs here, beside the phrases it is always written with.
    ("clinical_research", r"clinical (research|trials?|studies)|research coordinator|\bcrc\b|translational (medicine|research|science)"),
    ("lab_research", r"\blab(oratory)?\b|wet lab|research technician|\breu\b|research experience for undergrad|undergraduate research|summer research|\bsurf\b"),

    # --- business / finance ---
    # "Investment(s)" on its own is the asset-management desk ("Investments Intern - Bank Loans",
    # "Wealth and Investment Management Intern"), except at a utility, where "Investment Planning"
    # is capital planning, and in "Social/Community Investments", which is giving. Together with the
    # financial-reporting phrases and engineering's R&D, test, reliability and maintenance words
    # below, this took 132 of the ~2,700 "other" titles in one export into a field.
    ("finance", r"banking|fixed income|summer analyst|markets group|global markets|portfolio solutions|crypto|investment operations|revenue management|\bfinance\b|financial (analyst|planning)|investment (bank|analy)|\bibd\b|equity research|private equity|venture capital|\bm&a\b|asset manage|wealth manage|credit|treasury|\bfp&a\b|risk (analyst|manage)|\b(market|operational|liquidity|counterparty|payment|price|fraud) risk( \w+){0,2} (intern|co-?op|analyst)|(intern|internship)\s*[-–,:|]\s*(\w+ ){0,2}(market|operational|payment|price|fraud) risk\b|fraud (&|and) risk|risk (and|&) valuation intern|financial (reporting|model|due diligence|management|systems|crimes|services|development program)|(?<!non-)(?<!social )(?<!community )\binvestments?\b(?! planning)"),
    ("accounting", r"assurance|risk advisory|claim auditor|\baccount(ing|ant)\b|\baudit\b|\btax\b|controller|bookkeep"),
    ("consulting", r"customer transformation|client solutions|business resilience|governance|consult|strategy (intern|analyst)|business analyst|management trainee"),
    ("marketing", r"\bcontent (intern|support)|publicist|pricing (strategy|&|and)|web content|marketing|brand|advertis|\bseo\b|social media|content (market|strateg)|\bcommunications|public relations|\bpr\b intern|growth|customer (experience|insights?)( \w+){0,3} (intern|co-?op|researcher)|customer insights? intern"),
    ("communications", r"publicist|\bcommunications|public relations|\bpr\b intern|media relations|speechwrit|press (office|intern|secretary)"),
    ("sales", r"\bsales\b|business development|account executive|account manager|client relations|customer success"),
    ("hr", r"people partner|people, engagement|employee (and|&) workplace|human resources|\bhr\b|recruit|talent acquisition|people operations"),
    ("operations", r"\boperations\b|\bcoo\b|shared services|order management|service installation|operations intern|business operations|project manage|process improvement|procurement|\bquality (assurance |control |systems )?(specialist|intern|co-?op)\b"),
    ("supply_chain", r"supply chain|logistic|procurement|sourcing|inventory|purchasing|distribution center|warehouse|inbound transportation|transportation network( \w+){0,2} intern"),
    ("entrepreneurship", r"entrepreneur|\bstart-?ups?\b|incubator|accelerator|small business"),
    ("economics", r"\beconomic|econometric|policy analys"),

    # --- design / media / arts / humanities ---
    ("design", r"\bux\b|\bui\b|user experience|user research|product design|graphic design|industrial design|\bfigma\b|visual design|interaction design"),
    ("media", r"journalis|editorial|\bwriting intern|content creat|video|film|photograph|broadcast|podcast|creative"),
    ("journalism", r"journalis|reporter|newsroom|\bnews\b|editorial"),
    ("publishing", r"publish|editorial|literary|\beditor\b|\bbooks?\b"),
    ("film", r"animat(or|ion)|rigging artist|production intern|\bfilm|video production|post-?production|cinematograph|production assistant|documentar"),
    ("music", r"\bmusic|record label|audio engineer|recording studio|concert"),
    ("theater", r"theat(er|re)\b|stage manag|performing arts|\bdance\b|\bopera\b|ballet"),
    ("law", r"\blegal\b|\blaw\b|paralegal|compliance|regulatory|\bcounsel\b|policy intern"),
    ("education", r"teaching|education|curriculum|instructor|tutor"),
    ("nonprofit", r"nonprofit|non-profit|social impact|community outreach|volunteer coordinat|development associate"),
    ("architecture", r"architect(ure|ural)|urban plan|landscape"),
    ("urban_planning", r"urban plan|city plan|regional plan|planning intern|transportation planning|zoning|\bgis\b|housing (policy|development)|community development"),
    ("psychology", r"psycholog|behavioral (health|science)|\bmental health|counsel(ing|or)\b|\baba\b|cognitive science|"
     # A BCBA fieldwork apprenticeship is a psychology role by any reading, and so is a
     # behaviour technician post: they are the commonest paid placement an undergraduate
     # psychology major can actually get. None of them say "psychology" in the title.
     r"\bbcba\b|\bbcaba\b|\brbt\b|applied behavio(u)?r|behavio(u)?r(al)? (analyst|analysis|technician)"),
    ("social_work", r"social work|case manag|human services|youth (program|development)|family services"),
    ("government", r"government|public (sector|service|affairs|administration)|legislative|congressional|municipal|\bfederal\b|state house"),
    ("arts", r"animator|\bmuseum|gallery|curator|fine arts|theat(er|re)\b|\bmusic\b|performing arts|arts (admin|management)|animation|illustrat"),
    ("museums", r"\bmuseum|curat(or|orial)|collections (intern|management|assistant)|archiv(e|es|ist|al)|exhibit"),
    ("library", r"librar(y|ian)|information science|archiv(e|es|ist|al)"),
    ("hospitality", r"hospitality|\bhotel|restaurant|culinary|food (and|&) beverage|event planning|\bevents? (intern|coordinat)|tourism"),
    ("sports", r"\bsports?\b|athletic|recreation|fitness|kinesiolog|exercise science"),
    ("agriculture", r"agricultur|agronom|horticultur|food science|animal science|veterinar|\bfarm\b|forestry|wildlife|conservation|food safety( (&|and) quality| quality( assurance)?)?( \w+){0,2} (intern|co-?op)|quality (&|and )?food safety"),
    ("sustainability", r"sustainab|climate|renewable|clean energy|conservation|environmental (policy|justice|education)|energy efficiency|recycl|(?<!high-)(?<!high )\benergy (intern|internship|assessment intern)|building energy model|advanced energy intern"),
    ("languages", r"translat(or|ion)s?\b|interpreter\b|bilingual|linguist|"
     # "interpreter\b" is deliberate: mechanistic interpretability is not an interpreting job.
     r"\besl\b|tesol\b|\btefl\b|english language (learn|cent|institute)|"
     r"language (access|instruct|teacher|tutor)|localiz(ation|ing)|localisation|world languages|foreign language"),
    ("real_estate", r"real estate|property manage|\breit\b|leasing"),
    ("insurance", r"insurance|underwrit|claims (analyst|intern)|actuar"),
    # The other half of the engineering fallback above: a posting that says business and
    # nothing more specific is still a business posting. "Business Analyst Intern",
    # "Business Management Intern", "Business Administration Intern". Business Development
    # is already sales and Business Intelligence is already data, so this never sees them.
    ("business", r"\bbusiness\b|\bcommercial\b|\bmba\b"),
    ("retail", r"\bretail\b|merchandis|buying intern|\bfashion\b|apparel|e-?commerce|\bstores?\b"),
]

# Every major in majors.py was run through these rules as "<major> Intern". 37 of the 92 matched
# nothing at all, which means a listing named after that discipline never reaches the student who
# studies it. Most of the 37 are not worth a rule: there is not one listing in 14,525 titled after
# art history, philosophy, classics, history or any area study, and a rule for a discipline nobody
# posts is tidy rather than useful. Five had real titles waiting, and those five are added above:
#
#     computer science   16 untagged titles   -> swe
#     geology/geoscience 24                   -> environmental
#     informatics         7                   -> data (and bioinformatics -> biology)
#     speech pathology    5                   -> health
#     geospatial/GIS      1                   -> environmental
#
# Two of the five had to be anchored before they were safe, for the reason the EHS rule above was:
# classify reads the description as well as the title, and a description says which degree it
# wants. A bare GIS acronym tagged any posting whose body mentioned a GIS layer, and a bare
# "speech language" tagged "Machine Learning Researcher, Multimodal LLMs", whose body describes
# speech and language models. "Computer science" was the worst of them: 202 bodies say it and
# every one is a degree list - "pursuing a degree in Computer Science", "mathematics, physics, and
# computer science" - so the bare word pulled a steel internship and an SEO internship into swe,
# 35 listings in all. It now declines to match where a comma, a slash or a preposition has put it,
# which keeps 33 of the 36 real titles and leaks one.
#
# The earth-science words were measured the same way and left unanchored. They do reach out of a
# body, but what they reach is "Production Geology - providing a field study" in an oil and gas
# posting and "a degree in Geosciences" on a cartography intern, which are the jobs an
# environmental student wants; only three of the thirty-five are wrong.
#
# "Management" was measured too - 64 untagged titles - and left alone deliberately: the bare word
# is "Portfolio Management" and "Waste Management" as often as it is a management trainee, and
# there is no honest single tag for it.
#
# A later pass over the 1,814 open listings still tagged only "other" added the tail alternations
# on finance (named risk desks), environmental (EHS and workplace/fire-life safety), agriculture
# (food safety), sustainability (energy interns), operations (quality specialist/intern), engineering
# (controls roles), civil (water and transportation), supply_chain (inbound transportation) and
# marketing (customer experience/insights). Each is tied to a role word - "intern", "co-op",
# "specialist" - so that it stays safe if classify is ever handed a description, where the bare
# phrases are boilerplate: "operational risk", "a high-energy intern experience", "Health,
# Safety, and Environment culture", "Internal Controls". normalize classifies the title alone,
# and on titles, against every open listing, they changed 95 and rescued 76 from "other".

STAGES = ("internship", "co_op", "research", "fellowship", "early_insight", "part_time", "apprenticeship")
YEARS = ("first_year", "sophomore", "junior", "senior", "masters", "phd")
_UNDERGRAD = YEARS[:4]

_STAGE_RULES = [
    ("co_op", re.compile(r"\bco-?op\b", re.I)),
    ("research", re.compile(r"\breu\b|research experience for undergrad|undergraduate research|student research|"
                            r"summer research (program|fellow|intern|scholar|assistant|opportunit)|\bsurf\b|"
                            r"\bresearch(er|ers)?\b", re.I)),
    ("fellowship", re.compile(r"\bfellowships?\b|\b(summer|student|undergrad(uate)?|graduate|policy|public service|"
                              r"diversity|emerging leaders?|research) fellows?\b", re.I)),
    ("early_insight", re.compile(r"\bdiscovery (program|day|week|series|internship)|\binsights? (day|week|program|series)|"
                                 r"early insight|\bexplore (program|internship)|exploration program|spring week|possibilities summit", re.I)),
    # "Working Student" is the German Werkstudent contract: a real part-time job for someone enrolled.
    ("part_time", re.compile(r"part[- ]time (intern|student)|\b(student|intern)\b.{0,25}part[- ]time|"
                             r"student (worker|assistant|employee|aide)|work[- ]study|academic[- ]year intern|"
                             r"semester intern|working student", re.I)),
    ("apprenticeship", re.compile(r"\bapprentice(ship)?s?\b", re.I)),
    # Plenty of employers never write "intern". Aramco Americas posts seventeen "<Department> -
    # 2027 Summer Student Program" and nothing else; elsewhere the role noun is simply "Student",
    # as in "Physical Design Student". Both were measured against 26,791 live titles from
    # greenhouse, lever and ashby boards: "summer student" never appears on a non-student posting,
    # and "student" heading the role matched nine titles, every one of them a student job.
    # Plural is left out on purpose - a title ending in "Students" is usually a job serving them,
    # like "Senior Product Manager, GPTZero - Students" - and so is "working", which is part_time.
    ("internship", re.compile(r"\bintern(ship)?s?\b|summer (analyst|associate|scholar|20[2-3]\d)|"
                              r"\bextern(ship)?s?\b|\bpracticum\b|student trainee|\bsummer students?\b|"
                              r"(?<!working )\bstudent\b(?=\s*([-,:(/|–—]|$))", re.I)),
]
_LOWER_YEARS_RE = re.compile(r"\b(freshm[ae]n|first[- ]year|sophomores?)\b", re.I)
_PROGRAM_RE = re.compile(r"\b(program|summit|day|week|series|academy|conference|forum|experience)\b", re.I)
_RESEARCH_AIDE_RE = re.compile(r"research (assistant|aide|technician)", re.I)
_STUDENT_WORD_RE = re.compile(r"\b(student|undergrad(uate)?|summer)\b", re.I)
_NEW_GRAD_RE = re.compile(r"new ?grad|early career|entry[- ]level|recent (college )?grad|university grad|"
                          r"graduate (development |rotational )?program|rotational program|leadership development program", re.I)
_NON_INTERN_RE = re.compile(r"\brecruiter\b|\bmanager\b|\bfull[- ]?time\b|\bdirector\b|\bsenior\b|\bstaff\b|\bprincipal\b|\blead\b", re.I)
# The separator is optional and it is not always a hyphen. Employers write "Post Doctoral
# Research Fellow" and "Post Doc Research Associate" as often as they write "Postdoctoral",
# and five of them were live on the board while this rule sat here meaning to exclude exactly
# those. One is titled "Post Doc Scientist Data Science AI/ML Intern"; it goes too, because a
# postdoc needs a finished PhD whatever else the title says, and that is already what this
# rule did to anyone who spelled it with a hyphen.
_NEVER_STUDENT_RE = re.compile(r"post[- ]?doc|post[- ]?doctoral|post[- ]?bacc|faculty|professor|physician|attending", re.I)
# The job of running an internship programme is not an internship. Universities and hospitals post
# plenty of them - "Assistant/Associate Coop Coordinator", "Manager, Internship Programs",
# "Practicum Coordinator II for Nursing" - and they came through, because the very words that make
# them staff jobs are the ones `explicit` below trusts to overrule _NON_INTERN_RE.
#
# Both kinds of word turn up in both kinds of title, so the test is which one heads the title.
# "Intern Coordinator" hires a coordinator; "Program Coordinator Intern" hires an intern. A word
# followed by a separator is the head - "Volunteer/Intern: Content Marketing Manager" hires the
# intern - and with no separator either way the later word wins, as in "Quality Coordinator Intern".
# "assistant" is deliberately not a staff word: a research assistant is a student.
_SEP = r"\s*([-,:(/|–—]|$)"
_STAFF_ROLE = (r"coordinator|supervisor|administrator|advis[eo]r|counselor|preceptor|liaison|"
               r"recruiter|manager|director")
_STUDENT_ROLE = (r"interns?|internships?|co-?ops?|externs?|externships?|trainees?|apprentices?|"
                 r"fellows?|fellowships?|student (worker|assistant|employee|aide)")
_STAFF_ROLE_RE = re.compile(rf"\b({_STAFF_ROLE})\b", re.I)
_STUDENT_ROLE_RE = re.compile(rf"\b({_STUDENT_ROLE})\b", re.I)
_STAFF_HEAD_RE = re.compile(rf"\b({_STAFF_ROLE})\b{_SEP}", re.I)
_STUDENT_HEAD_RE = re.compile(rf"\b({_STUDENT_ROLE})\b{_SEP}", re.I)
# "Coordinator of Student Internships" is staff; "Summer Intern - Product Manager for X" is not,
# which is why this only counts when it comes before any student word.
_RUNS_PROGRAM_RE = re.compile(rf"\b({_STAFF_ROLE})\b\s+(of|for)\b", re.I)
# Work-study is a student job by definition, whatever the role is called.
_WORK_STUDY_RE = re.compile(r"work[- ]?study", re.I)


def _runs_the_programme(title: str) -> bool:
    """True for the staff job that administers a programme, rather than a place on one."""
    staff = _STAFF_ROLE_RE.search(title)
    if not staff or _WORK_STUDY_RE.search(title):
        return False
    student = _STUDENT_ROLE_RE.search(title)
    if not student:
        return True
    runs = _RUNS_PROGRAM_RE.search(title)
    if runs and runs.start() < student.start():
        return True
    if _STUDENT_HEAD_RE.search(title):
        return False
    if _STAFF_HEAD_RE.search(title):
        return True
    last = lambda rx: max(m.start() for m in rx.finditer(title))
    return last(_STAFF_ROLE_RE) > last(_STUDENT_ROLE_RE)


# Tags that describe the shape of a posting rather than its discipline, added by a rule that
# matches the word in the title and taken off again the moment a real discipline matched.
_FALLBACK_FIELDS = frozenset({"engineering", "business"})


def classify(title: str, description: str = "") -> list[str]:
    text = f"{title} {description or ''}".lower()
    tags: list[str] = []
    for tag, pat in RULES:
        if re.search(pat, text):
            tags.append(tag)
    seen = set()
    out = [t for t in tags if not (t in seen or seen.add(t))]
    specific = [t for t in out if t not in _FALLBACK_FIELDS]
    if specific:
        out = specific          # a fallback stands only when nothing more specific matched
    # Never drop an internship just because our vocabulary missed it.
    return out or ["other"]


def stage_of(title: str, employment_type: str = "") -> list[str]:
    """Student-opportunity stages for a posting, in STAGES order. Empty = not a student role."""
    title = title or ""
    emp = employment_type or ""
    if _NEVER_STUDENT_RE.search(title) or _runs_the_programme(title):
        return []
    found = {s for s, rx in _STAGE_RULES if rx.search(title)}
    if _LOWER_YEARS_RE.search(title) and _PROGRAM_RE.search(title):
        found.add("early_insight")
    if _RESEARCH_AIDE_RE.search(title) and _STUDENT_WORD_RE.search(title):
        found.add("research")
    if re.search(r"\bintern", emp, re.I):
        found.add("internship")
    if re.search(r"\bco-?op\b", emp, re.I):
        found.add("co_op")
    if found and re.search(r"part[- ]?time", emp, re.I):
        found.add("part_time")
    if not found:
        return []
    # a dated summer role ("Early Career Mechanical Engineering - Summer 2027") is an internship
    explicit = re.search(r"\bintern(ship)?s?\b|\bco-?op\b|\bsummer 20[2-3]\d\b", title, re.I)
    if _NEW_GRAD_RE.search(title) and not explicit:
        return []
    if _NON_INTERN_RE.search(title) and not explicit:
        return []
    return [s for s in STAGES if s in found]


def is_internship(title: str, employment_type: str = "") -> bool:
    """True for any student opportunity (internship, co-op, research, fellowship, ...)."""
    return bool(stage_of(title, employment_type))


def years_of(title: str, insights: dict | None = None) -> list[str]:
    """Class years a posting is limited to, in YEARS order. Empty = open to everyone."""
    t = title or ""
    ins = insights or {}
    ys: set[str] = set()
    if re.search(r"\bph\.?\s?d\b|\bdoctoral\b", t, re.I) or ins.get("degree_only") == "phd":
        ys.add("phd")
    if (re.search(r"\bmasters?\b|\bmba\b|\bmpp\b|\bmph\b|graduate (student|intern|co-?op)|(?<!, )\bms\b(?!\s*office)", t, re.I)
            or ins.get("degree_only") == "masters"):
        ys.add("masters")
    standing = set()
    for s in ins.get("class_standing") or []:
        standing.add("first_year" if s == "freshman" else s)
    if re.search(r"\b(freshm[ae]n|first[- ]year)\b", t, re.I):
        standing.add("first_year")
    if re.search(r"\bsophomores?\b", t, re.I):
        standing.add("sophomore")
    for s in ("junior", "senior"):
        if re.search(rf"\brising {s}s?\b|\b{s}s? (year|standing|students?|undergrad)", t, re.I):
            standing.add(s)
    if standing:
        ys |= standing
    elif re.search(r"undergrad|\bug\b|bachelor", t, re.I):
        ys.update(_UNDERGRAD)
    return [y for y in YEARS if y in ys]


ALL_FIELDS = tuple(dict.fromkeys(tag for tag, _ in RULES)) + ("other",)

# Employer sector -> field, used only when a title matched no field ("Research Intern" at a hospital).
SECTOR_FIELDS = {
    "health": "health", "nonprofit": "nonprofit", "media": "media", "education_research": "education",
    "government_policy": "government", "arts_museums": "arts", "hospitality_sports": "hospitality",
    "insurance_finance": "finance", "quant_finance": "finance", "energy_environment": "sustainability",
    "retail_consumer": "retail",
    # Mental-health and autism-services providers. Their clinical internships are titled by degree
    # level rather than by discipline, so the employer is the only thing that says psychology.
    "behavioral_health": "psychology",
}
