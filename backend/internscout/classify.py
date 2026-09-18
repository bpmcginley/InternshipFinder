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
    ("ml", r"\bml\b|machine learning|deep learning|\bnlp\b|computer vision|\bai\b|artificial intelligence|genai|llm|research scientist|reinforcement learning"),
    ("data", r"\bdata (scien|engineer|analy|platform)|\banalytics\b|business intelligence|\bbi\b|\betl\b|data warehouse|\bdata\b"),
    ("security", r"surveillance analyst|detection engineer|privacy engineer|\bsecurity\b|cryptograph|\bappsec\b|penetration|infosec|cyber"),
    ("hardware", r"\bhardware\b|\basic\b|\bfpga\b|embedded|\bvlsi\b|firmware|silicon|chip design|analog|circuit|semiconductor|robotics|mechatronic"),
    ("swe", r"digital innovation|applied technolog|extended reality|\bxr\b|algorithm develop|digital labs|software|\bswe\b|\bsde\b|developer|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|web dev|mobile|\bios\b|android|platform|infrastructur|devops|\bsre\b|cloud|distributed|compiler|graphics|game dev|\bqa\b|quality assurance|test engineer|application develop|technical staff|supercomputing|high performance computing|\bhpc\b|systems engineer|solutions engineer|forward deployed|technology|\bit\b|information technology"),
    ("pm", r"\bproduct (intern|specialist|development intern)|digital product|product manage|program manage|technical program|\btpm\b|product owner"),

    # --- engineering (non-software) ---
    ("electrical", r"\belectrical\b|mixed[- ]signal|physical design|\brf\b|power electronics|lighting design|electrical engineer|\bpower systems\b|\bee\b intern"),
    ("mechanical", r"\bmechanical\b|product development engineer|design release|life ?cycle engineer|mechanical engineer|\bme\b intern|thermal|manufactur|cad\b|solidworks|hvac"),
    ("civil", r"\bstructural\b|commissioning|civil engineer|structural engineer|geotechnical|transportation engineer|construction"),
    ("aerospace", r"aerospace|aeronautic|astronautic|propulsion|avionics|flight (test|science)"),
    ("chemical", r"chemical engineer|process engineer|petroleum|refin"),
    ("materials", r"materials (science|engineer)|metallurg|polymer"),
    ("industrial", r"industrial engineer|systems engineering|operations research|supply chain|logistics|manufacturing engineer"),
    ("environmental", r"environmental|sustainab|climate|renewable|energy engineer|water resources"),
    ("biomedical", r"biomedical|bioengineer|medical device|clinical engineer"),

    # --- sciences / math / health ---
    ("biology", r"\bbiolog|biotech|genomic|molecular|microbiolog|neuroscience|immunolog|cell (culture|biology)|life sciences|pharma|drug discovery"),
    ("chemistry", r"bioanalytical|analytical sciences|\bchemist|chemical (research|analysis)|analytical chem|organic chem"),
    ("physics", r"\bphysics\b|photonic|optic|quantum (computing|research|physics)|astronom"),
    ("math", r"\bmathematic|applied math|\bstatistic|biostatistic|actuarial"),
    ("health", r"health systems|value (and|&) access|\bnursing\b|clinical|public health|epidemiolog|healthcare|health care|patient|medical (assistant|research)|hospital"),
    ("nursing", r"\bnurs(e|es|ing)\b|\bcna\b|\brn\b|patient care (tech|assistant)"),
    ("public_health", r"public health|epidemiolog|community health|global health|health (policy|equity|promotion|education|services research)"),
    ("clinical_research", r"clinical (research|trials?|studies)|research coordinator|\bcrc\b"),
    ("lab_research", r"\blab(oratory)?\b|wet lab|research technician|\breu\b|research experience for undergrad|undergraduate research|summer research|\bsurf\b"),

    # --- business / finance ---
    ("finance", r"banking|fixed income|summer analyst|markets group|global markets|portfolio solutions|crypto|investment operations|revenue management|\bfinance\b|financial (analyst|planning)|investment (bank|analy)|\bibd\b|equity research|private equity|venture capital|\bm&a\b|asset manage|wealth manage|credit|treasury|\bfp&a\b|risk (analyst|manage)"),
    ("accounting", r"assurance|risk advisory|claim auditor|\baccount(ing|ant)\b|\baudit\b|\btax\b|controller|bookkeep"),
    ("consulting", r"customer transformation|client solutions|business resilience|governance|consult|strategy (intern|analyst)|business analyst|management trainee"),
    ("marketing", r"\bcontent (intern|support)|publicist|pricing (strategy|&|and)|web content|marketing|brand|advertis|\bseo\b|social media|content (market|strateg)|communications|public relations|\bpr\b intern|growth"),
    ("communications", r"publicist|communications|public relations|\bpr\b intern|media relations|speechwrit|press (office|intern|secretary)"),
    ("sales", r"\bsales\b|business development|account executive|account manager|client relations|customer success"),
    ("hr", r"people partner|people, engagement|employee (and|&) workplace|human resources|\bhr\b|recruit|talent acquisition|people operations"),
    ("operations", r"\boperations\b|\bcoo\b|shared services|order management|service installation|operations intern|business operations|project manage|process improvement|procurement"),
    ("supply_chain", r"supply chain|logistic|procurement|sourcing|inventory|purchasing|distribution center|warehouse"),
    ("entrepreneurship", r"entrepreneur|\bstart-?ups?\b|incubator|accelerator|small business"),
    ("economics", r"\beconomic|econometric|policy analys"),

    # --- design / media / arts / humanities ---
    ("design", r"\bux\b|\bui\b|user experience|user research|product design|graphic design|industrial design|\bfigma\b|visual design|interaction design"),
    ("media", r"journalis|editorial|writing intern|content creat|video|film|photograph|broadcast|podcast|creative"),
    ("journalism", r"journalis|reporter|newsroom|\bnews\b|editorial"),
    ("publishing", r"publish|editorial|literary|\beditor\b|\bbooks?\b"),
    ("film", r"animat(or|ion)|rigging artist|production intern|\bfilm|video production|post-?production|cinematograph|production assistant|documentar"),
    ("music", r"\bmusic|record label|audio engineer|recording studio|concert"),
    ("theater", r"theat(er|re)\b|stage manag|performing arts|\bdance\b|\bopera\b|ballet"),
    ("law", r"\blegal\b|\blaw\b|paralegal|compliance|regulatory|counsel|policy intern"),
    ("education", r"teaching|education|curriculum|instructor|tutor"),
    ("nonprofit", r"nonprofit|non-profit|social impact|community outreach|volunteer coordinat|development associate"),
    ("architecture", r"architect(ure|ural)|urban plan|landscape"),
    ("urban_planning", r"urban plan|city plan|regional plan|planning intern|transportation planning|zoning|\bgis\b|housing (policy|development)|community development"),
    ("psychology", r"psycholog|behavioral (health|science)|mental health|counsel(ing|or)\b|\baba\b|cognitive science|"
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
    ("agriculture", r"agricultur|agronom|horticultur|food science|animal science|veterinar|\bfarm\b|forestry|wildlife|conservation"),
    ("sustainability", r"sustainab|climate|renewable|clean energy|conservation|environmental (policy|justice|education)|energy efficiency|recycl"),
    ("languages", r"translat(or|ion)|interpreter\b|bilingual|linguist|"
     # "interpreter\b" is deliberate: mechanistic interpretability is not an interpreting job.
     r"\besl\b|tesol\b|\btefl\b|english language (learn|cent|institute)|"
     r"language (access|instruct|teacher|tutor)|localiz(ation|ing)|localisation|world languages|foreign language"),
    ("real_estate", r"real estate|property manage|\breit\b|leasing"),
    ("insurance", r"insurance|underwrit|claims (analyst|intern)|actuar"),
    ("retail", r"\bretail\b|merchandis|buying intern|\bfashion\b|apparel|e-?commerce|store operations"),
]

STAGES = ("internship", "co_op", "research", "fellowship", "early_insight", "part_time", "apprenticeship")
YEARS = ("first_year", "sophomore", "junior", "senior", "masters", "phd")
_UNDERGRAD = YEARS[:4]

_STAGE_RULES = [
    ("co_op", re.compile(r"\bco-?op\b", re.I)),
    ("research", re.compile(r"\breu\b|research experience for undergrad|undergraduate research|student research|"
                            r"summer research (program|fellow|intern|scholar|assistant|opportunit)|\bsurf\b", re.I)),
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
_NEVER_STUDENT_RE = re.compile(r"post-?doc|post-?doctoral|post-?bacc|faculty|professor|physician|attending", re.I)
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


def classify(title: str, description: str = "") -> list[str]:
    text = f"{title} {description or ''}".lower()
    tags: list[str] = []
    for tag, pat in RULES:
        if re.search(pat, text):
            tags.append(tag)
    seen = set()
    out = [t for t in tags if not (t in seen or seen.add(t))]
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
}
