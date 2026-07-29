"""Field tagging across college disciplines.

Tags are ordered most-specific first; a posting can carry several. Anything that
matches nothing gets "other" (kept, but scored low) rather than silently dropped,
so coverage never depends on this list being exhaustive.
"""
from __future__ import annotations
import re

RULES = [
    # --- computing / quant ---
    ("quant", r"\bquant(itative)?\b|\btrader\b|\btrading\b|market mak|derivativ|\balpha\b|portfolio manag"),
    ("ml", r"\bml\b|machine learning|deep learning|\bnlp\b|computer vision|\bai\b|artificial intelligence|genai|llm|research scientist|reinforcement learning"),
    ("data", r"\bdata (scien|engineer|analy|platform)|\banalytics\b|business intelligence|\bbi\b|\betl\b|data warehouse|\bdata\b"),
    ("security", r"\bsecurity\b|cryptograph|\bappsec\b|penetration|infosec|cyber"),
    ("hardware", r"\bhardware\b|\basic\b|\bfpga\b|embedded|\bvlsi\b|firmware|silicon|chip design|analog|circuit|semiconductor|robotics|mechatronic"),
    ("swe", r"software|\bswe\b|\bsde\b|developer|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|web dev|mobile|\bios\b|android|platform|infrastructur|devops|\bsre\b|cloud|distributed|compiler|graphics|game dev|\bqa\b|quality assurance|test engineer|application develop|technical staff|supercomputing|high performance computing|\bhpc\b|systems engineer|solutions engineer|forward deployed|technology|\bit\b|information technology"),
    ("pm", r"product manage|program manage|technical program|\btpm\b|product owner"),

    # --- engineering (non-software) ---
    ("electrical", r"electrical engineer|\bpower systems\b|\bee\b intern"),
    ("mechanical", r"mechanical engineer|\bme\b intern|thermal|manufactur|cad\b|solidworks|hvac"),
    ("civil", r"civil engineer|structural engineer|geotechnical|transportation engineer|construction"),
    ("aerospace", r"aerospace|aeronautic|astronautic|propulsion|avionics|flight (test|science)"),
    ("chemical", r"chemical engineer|process engineer|petroleum|refin"),
    ("materials", r"materials (science|engineer)|metallurg|polymer"),
    ("industrial", r"industrial engineer|systems engineering|operations research|supply chain|logistics|manufacturing engineer"),
    ("environmental", r"environmental|sustainab|climate|renewable|energy engineer|water resources"),
    ("biomedical", r"biomedical|bioengineer|medical device|clinical engineer"),

    # --- sciences / math ---
    ("biology", r"\bbiolog|biotech|genomic|molecular|microbiolog|neuroscience|immunolog|cell (culture|biology)|life sciences|pharma|drug discovery"),
    ("chemistry", r"\bchemist|chemical (research|analysis)|analytical chem|organic chem"),
    ("physics", r"\bphysics\b|photonic|optic|quantum (computing|research|physics)|astronom"),
    ("math", r"\bmathematic|applied math|\bstatistic|biostatistic|actuarial"),
    ("health", r"\bnursing\b|clinical|public health|epidemiolog|healthcare|patient|medical (assistant|research)|hospital"),

    # --- business / finance ---
    ("finance", r"\bfinance\b|financial (analyst|planning)|investment (bank|analy)|\bibd\b|equity research|private equity|venture capital|\bm&a\b|asset manage|wealth manage|credit|treasury|\bfp&a\b|risk (analyst|manage)"),
    ("accounting", r"\baccount(ing|ant)\b|\baudit\b|\btax\b|controller|bookkeep"),
    ("consulting", r"consult|strategy (intern|analyst)|business analyst|management trainee"),
    ("marketing", r"marketing|brand|advertis|\bseo\b|social media|content (market|strateg)|communications|public relations|\bpr\b intern|growth"),
    ("sales", r"\bsales\b|business development|account executive|account manager|client relations|customer success"),
    ("hr", r"human resources|\bhr\b|recruit|talent acquisition|people operations"),
    ("operations", r"operations intern|business operations|project manage|process improvement|procurement"),
    ("economics", r"\beconomic|econometric|policy analys"),

    # --- design / media / humanities ---
    ("design", r"\bux\b|\bui\b|user experience|user research|product design|graphic design|industrial design|\bfigma\b|visual design|interaction design"),
    ("media", r"journalis|editorial|writing intern|content creat|video|film|photograph|broadcast|podcast|creative"),
    ("law", r"\blegal\b|\blaw\b|paralegal|compliance|regulatory|counsel|policy intern"),
    ("education", r"teaching|education|curriculum|instructor|tutor"),
    ("nonprofit", r"nonprofit|non-profit|social impact|community outreach|volunteer coordinat|development associate"),
    ("architecture", r"architect(ure|ural)|urban plan|landscape"),
]

INTERN_RE = re.compile(r"\b(intern|internship|co-?op|new ?grad|early career|apprentice|trainee|summer analyst|campus)\b", re.I)
_NON_INTERN_RE = re.compile(r"\brecruiter\b|\bmanager\b|\bfull[- ]?time\b|\bdirector\b|\bsenior\b|\bstaff\b|\bprincipal\b|\blead\b", re.I)


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


def is_internship(title: str, employment_type: str = "") -> bool:
    t = f"{title} {employment_type or ''}"
    if not INTERN_RE.search(t):
        return False
    if _NON_INTERN_RE.search(title) and not re.search(r"\bintern(ship)?\b|\bco-?op\b", title, re.I):
        return False
    return True


ALL_FIELDS = tuple(tag for tag, _ in RULES) + ("other",)
