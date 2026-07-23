"""Rule-based field tagging from title (and description if present).

Returns a list of tags from: swe, quant, data, ml, hardware, pm, security, other.
Off-target roles get [] (or only 'other') and are dropped by the pipeline.
"""
from __future__ import annotations
import re

# order matters: more specific first
RULES = [
    ("quant", r"\bquant(itative)?\b|\btrader?\b|\btrading\b|\bquant researcher\b|\bquant dev"),
    ("ml", r"\bml\b|machine learning|deep learning|\bnlp\b|computer vision|\bai\b|research scientist"),
    ("data", r"\bdata (scien|engineer|analy)|\banalytics\b|\bdata\b"),
    ("hardware", r"\bhardware\b|\basic\b|\bfpga\b|embedded|electrical|\bvlsi\b|firmware"),
    ("security", r"security|cryptograph|\bappsec\b|penetration"),
    ("swe", r"software|\bswe\b|\bsde\b|developer|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|\bengineer\b|platform|infrastructure|\bios\b|android|web"),
    ("pm", r"product manager|\bpm\b|program manager|product management"),
]

INTERN_RE = re.compile(r"\b(intern|internship|co-?op|new ?grad|early career|apprentice)\b", re.I)
_NON_INTERN_RE = re.compile(r"\brecruiter\b|\bmanager\b|\bfull[- ]?time\b", re.I)


def classify(title: str, description: str = "") -> list[str]:
    text = f"{title} {description or ''}".lower()
    tags: list[str] = []
    for tag, pat in RULES:
        if re.search(pat, text):
            tags.append(tag)
    # de-dup preserving order
    seen = set()
    out = [t for t in tags if not (t in seen or seen.add(t))]
    return out


def is_internship(title: str, employment_type: str = "") -> bool:
    t = f"{title} {employment_type or ''}"
    if not INTERN_RE.search(t):
        return False
    # e.g. "University Recruiter", "Intern Manager" are not internships
    if _NON_INTERN_RE.search(title) and not re.search(r"\bintern(ship)?\b", title, re.I):
        return False
    return True
