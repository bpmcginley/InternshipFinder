"""Pull requirements out of a job description: skills (required vs preferred), eligibility limits
(grad year, class standing, citizenship, clearance, degree level, GPA, sponsorship) and deadline.

Skill patterns are exported to the dashboard (stats.json) and run there against the user's profile
with JavaScript's RegExp, so keep them to syntax both engines share: no inline flags, no \\Z.
"""
from __future__ import annotations
import re
from datetime import date

_B = r"(?<![A-Za-z0-9+#])"   # boundary that works for C++ / C# / .NET
_E = r"(?![A-Za-z0-9+#])"

SKILLS: dict[str, str] = {
    "Python": r"python",
    "Java": r"java(?!\s*script)",
    "C++": r"c\+\+",
    "C#": r"c#|\.net",
    "JavaScript": r"javascript|js",
    "TypeScript": r"typescript",
    "Go": r"golang",
    "Rust": r"rust(?: programming| language)",
    "Kotlin": r"kotlin",
    "Swift": r"swift(?:ui)?(?= |,|\.|/)",
    "Scala": r"scala",
    "R": r"rstudio|r programming|python(?: and| or|,|/) r|r(?: and| or|,|/) python",
    "MATLAB": r"matlab",
    "SQL": r"sql|mysql|postgres(?:ql)?|sqlite|t-sql",
    "NoSQL": r"nosql|mongodb|dynamodb|cassandra",
    "HTML/CSS": r"html5?|css3?",
    "React": r"react(?:\.js|js| native)?(?! to)",
    "Node.js": r"node(?:\.js|js)",
    "Angular": r"angular(?:js)?",
    "Vue": r"vue(?:\.js)?",
    "Django/Flask": r"django|flask|fastapi",
    "Spring": r"spring boot|spring framework",
    "REST APIs": r"rest(?:ful)? apis?|rest services",
    "GraphQL": r"graphql",
    "AWS": r"aws|amazon web services",
    "Azure": r"azure",
    "GCP": r"gcp|google cloud",
    "Docker": r"docker|containers?",
    "Kubernetes": r"kubernetes|k8s",
    "Linux": r"linux|unix",
    "Git": r"git|github|gitlab|version control",
    "CI/CD": r"ci/cd|continuous integration",
    "Spark": r"spark|pyspark|databricks",
    "Kafka": r"kafka",
    "Airflow": r"airflow",
    "Snowflake": r"snowflake",
    "pandas/NumPy": r"pandas|numpy",
    "scikit-learn": r"scikit-learn|sklearn",
    "PyTorch": r"pytorch",
    "TensorFlow": r"tensorflow|keras",
    "Machine learning": r"machine learning|ml",
    "Deep learning": r"deep learning|neural networks?",
    "NLP": r"nlp|natural language processing",
    "LLMs": r"llms?|large language models?|generative ai|genai",
    "Computer vision": r"computer vision|opencv",
    "Statistics": r"statistics|statistical",
    "Probability": r"probability|stochastic",
    "Linear algebra": r"linear algebra",
    "Data structures & algorithms": r"data structures|algorithms",
    "Object-oriented programming": r"object[- ]oriented|oop",
    "Distributed systems": r"distributed systems",
    "Operating systems": r"operating systems",
    "Networking": r"computer networks?|networking protocols|tcp/ip",
    "Cybersecurity": r"cyber ?security|information security|penetration testing|security\+",
    "Excel": r"excel|spreadsheets?",
    "VBA": r"vba",
    "Tableau": r"tableau",
    "Power BI": r"power ?bi",
    "Salesforce": r"salesforce",
    "SAP": r"sap",
    "Bloomberg": r"bloomberg terminal|bloomberg",
    "Financial modeling": r"financial model(?:l)?ing|dcf|valuation",
    "Accounting": r"accounting|gaap",
    "Figma": r"figma",
    "Adobe Creative Suite": r"adobe|photoshop|illustrator|indesign|premiere pro",
    "SEO": r"seo",
    "Google Analytics": r"google analytics",
    "CAD": r"cad|computer[- ]aided design",
    "SolidWorks": r"solidworks",
    "AutoCAD": r"autocad",
    "CATIA/Creo/NX": r"catia|creo|siemens nx",
    "ANSYS/FEA": r"ansys|fea|finite element",
    "Simulink": r"simulink",
    "LabVIEW": r"labview",
    "Verilog/VHDL": r"verilog|systemverilog|vhdl",
    "FPGA": r"fpgas?",
    "PCB design": r"pcb|printed circuit boards?|altium",
    "Embedded systems": r"embedded|firmware|rtos",
    "Microcontrollers": r"microcontrollers?|arduino|raspberry pi|stm32",
    "Lab equipment": r"oscilloscopes?|multimeters?|spectrum analyzers?",
    "GD&T": r"gd&t",
    "3D printing": r"3d printing|additive manufacturing",
    "Wet lab": r"pcr|cell culture|western blots?|elisa|hplc|chromatography",
    "Unity/Unreal": r"unity3d|unity engine|unreal engine",
    "iOS": r"ios",
    "Android": r"android",
    "Agile": r"agile (?:methodolog[a-z]*|development|software|practices|frameworks?|sprints?|environment)|scrum|jira",
}
PATTERNS = {name: _B + "(?:" + p + ")" + _E for name, p in SKILLS.items()}
_COMPILED = {name: re.compile(p, re.I) for name, p in PATTERNS.items()}

_PREF_LINE = re.compile(r"preferred|nice[- ]to[- ]have|a plus\b|is a plus|are a plus|bonus|desired|desirable|ideally|stand out", re.I)
_REQ_HEAD = re.compile(r"requirement|required|qualifications|what you(?:'ll| will)? (?:need|bring)|must[- ]have|minimum|basic|who you are|you have|skills|about you", re.I)
_OTHER_HEAD = re.compile(r"responsibilit|what you(?:'ll| will) do|about (?:the|this) (?:role|team|job)|about us|benefits|compensation|salary|pay range|equal opportunity|perks", re.I)

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _segments(text: str) -> list[str]:
    parts = re.split(r"\n+|\s*[•·▪●◦]\s*|(?<=[.;:])\s+(?=[A-Z])", text or "")
    return [p.strip() for p in parts if p and p.strip()]


def extract_skills(text: str) -> list[dict]:
    """[{name, level}] with level "required" or "preferred"; a skill seen in both counts as required."""
    mode = "required"
    found: dict[str, str] = {}
    for seg in _segments(text):
        short = len(seg) <= 70
        if short and _PREF_LINE.search(seg):
            mode = "preferred"
        elif short and _OTHER_HEAD.search(seg):
            mode = "other"
        elif short and _REQ_HEAD.search(seg):
            mode = "required"
        level = "preferred" if (mode == "preferred" or _PREF_LINE.search(seg)) else "required"
        for name, rx in _COMPILED.items():
            if rx.search(seg) and found.get(name) != "required":
                found[name] = level
    return [{"name": n, "level": lvl} for n, lvl in found.items()]


def _near_eeo(text: str, start: int) -> bool:
    return bool(re.search(r"regard|regardless|discriminat|protected", text[max(0, start - 60):start], re.I))


def _parse_date(s: str, today: date) -> str | None:
    s = s.strip().lower()
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
    else:
        m = re.match(r"([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?", s)
        if not m or m.group(1) not in MONTHS:
            return None
        mo, d = MONTHS[m.group(1)], int(m.group(2))
        y = int(m.group(3)) if m.group(3) else today.year
    try:
        out = date(y, mo, d)
    except ValueError:
        return None
    if not (m.lastindex and m.lastindex >= 3 and m.group(3)) and out < today:
        out = out.replace(year=out.year + 1)  # "apply by March 1" with no year: the next one
    return out.isoformat()


def extract(text: str | None, today: date | None = None) -> dict:
    """Everything worth showing next to a listing; empty keys are left out."""
    text = text or ""
    today = today or date.today()
    out: dict = {}
    skills = extract_skills(text)
    if skills:
        out["skills"] = skills

    years: set[int] = set()
    for m in re.finditer(r"graduat|class of", text, re.I):
        window = re.split(r"[.;\n]", text[m.start():m.start() + 110])[0]
        years.update(int(y) for y in re.findall(r"\b(20[2-3]\d)\b", window))
    if years:
        out["grad_years"] = sorted(years)

    standing = {s.lower().rstrip("s") for s in re.findall(
        r"\b(?:rising|current(?:ly)? an?|incoming)\s+(freshm[ae]n|sophomores?|juniors?|seniors?)\b", text, re.I)}
    standing |= {s.lower().rstrip("s") for s in re.findall(
        r"\b(sophomores?|juniors?|seniors?)(?:\s+(?:or|and)\s+(?:sophomores?|juniors?|seniors?))?\s+(?:year|standing|students?|undergraduates?)\b", text, re.I)}
    standing |= {s.lower() for s in re.findall(
        r"\b(?:sophomore|junior|senior)s?\s+or\s+(sophomore|junior|senior)s?\s+(?:year|standing|students?)", text, re.I)}
    standing = {"freshman" if s.startswith("freshm") else s for s in standing}
    if standing:
        out["class_standing"] = sorted(standing)

    for m in re.finditer(r"u\.?\s?s\.?\s+citizen(?:ship)?|united states citizen(?:ship)?|citizens? of the united states|\bus persons?\b|u\.s\. persons?|\bitar\b|export control", text, re.I):
        if _near_eeo(text, m.start()):
            continue
        tail = text[m.end():m.end() + 60]
        out["citizenship"] = "citizen_or_pr" if re.search(r"permanent resident|green card|lawful", tail, re.I) and out.get("citizenship") != "citizen" else "citizen"
        if out["citizenship"] == "citizen":
            break

    if re.search(r"(?:security|secret|top secret|dod|government)\s+clearance|clearance\s+(?:is\s+)?required|(?:obtain|maintain|hold)\s+(?:and\s+maintain\s+)?(?:an?\s+)?(?:active\s+)?(?:security\s+)?clearance|ts/sci|polygraph", text, re.I):
        out["clearance"] = True

    has_undergrad = re.search(r"bachelor|undergrad|b\.s\.|\bbs\b|\bba\b|b\.a\.|sophomore|junior|senior", text, re.I)
    if not has_undergrad:
        if re.search(r"ph\.?\s?d\.?\s+(?:students?|candidates?|program)|(?:pursuing|enrolled in|currently in)[^.\n]{0,40}ph\.?\s?d", text, re.I):
            out["degree_only"] = "phd"
        elif re.search(r"master'?s\s+(?:students?|candidates?|program)|(?:pursuing|enrolled in|currently in)[^.\n]{0,40}master'?s", text, re.I):
            out["degree_only"] = "masters"

    # drop the scale ("on a 4.0 scale", "out of 4.0", "/4.0") so it isn't read as the minimum
    text_g = re.sub(r"(?:on|out of|of)\s+an?\s+\d\.\d{1,2}\s*(?:point\s+)?scale|out of\s+\d\.\d{1,2}|/\s*4\.0{1,2}\b|\d\.\d{1,2}\s+scale", " ", text, flags=re.I)
    gpas = [float(g) for g in re.findall(r"(?:gpa|grade point average)[^.\n\d]{0,30}(\d\.\d{1,2})", text_g, re.I)]
    gpas += [float(g) for g in re.findall(r"(\d\.\d{1,2})\s*(?:/\s*4\.0\s*)?(?:\+|or (?:higher|above|better))?\s*(?:cumulative\s+|minimum\s+)?(?:gpa|grade point)", text_g, re.I)]
    gpas = [g for g in gpas if 2.0 <= g <= 4.0]
    if gpas:
        out["gpa_min"] = max(gpas)

    if re.search(r"(?:not|unable to|cannot|won't|will not|does not|do not)\s+(?:be able to\s+)?(?:provide|offer|support|sponsor)[^.\n]{0,40}sponsor|(?:not|unable to|cannot|will not|does not|do not)\s+sponsor|without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:employment\s+)?(?:visa\s+)?sponsorship|sponsorship\s+(?:is\s+|will\s+)?not\s+(?:be\s+)?(?:available|provided|offered)", text, re.I):
        out["no_sponsorship"] = True

    m = re.search(r"(?:deadline|apply by|apply before|applications?\s+(?:are\s+|is\s+|will\s+be\s+)?(?:due|close[sd]?|accepted\s+(?:until|through))|submit[^.\n]{0,25}\bby)[^.\n\d]{0,25}"
                  r"((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d\d)?|\d{1,2}/\d{1,2}/(?:20)?\d\d)", text, re.I)
    if m:
        d = _parse_date(m.group(1), today)
        if d:
            out["deadline"] = d
    return out
