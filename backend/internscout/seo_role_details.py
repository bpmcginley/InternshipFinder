"""Small static employer-page cohort: concise facts supported by exported posting text."""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime, timezone

from . import insights

# 2026-10-28: was: static cards only showed title, place, term and pay. Limit this observation
# cohort to four retained employer pages; no page-selection or indexing rule depends on it.
# Revert: empty COHORT_PATHS (or remove the seo_pages call) to restore the existing cards.
COHORT_EMPLOYERS = {"under armour": "/internships/at/under-armour/", "medtronic": "/internships/at/medtronic/",
                    "lyft": "/internships/at/lyft/", "bose": "/internships/at/bose/"}
COHORT_PATHS = frozenset(COHORT_EMPLOYERS.values())
FILE = "seo-posting-details.json"
INSIGHTS_VERSION = 2       # must match export_static.INSIGHTS_TEXT_VERSION; fail closed on old text
MAX_DESCRIPTION = 100_000
MAX_SIDECAR_BYTES = 8_000_000
MAX_SKILLS = 4
MAX_ROWS = 160             # four cohort pages, at most the existing 40 visible cards on each
SOURCE_DAYS = 7            # a carried source check never silently becomes a new source check
_SHARD = re.compile(r"(?:[A-Z]{2}|Canada|remote)\Z")
_NEGATIVE = re.compile(r"\b(?:no|not|never|without|except|excluding|neither)\b|rather than", re.I)
_OTHER = re.compile(r"equal opportunity|without regard|does not discriminate|benefits include", re.I)
_GRADUATION = re.compile(r"graduation|graduating|graduate(?:s|d)?\s+(?:in|by|between|from|during|before|after)|class of", re.I)
_CLASS = {
    "freshman": re.compile(r"\b(?:freshm[ae]n|first[- ]year)\b", re.I),
    "sophomore": re.compile(r"\bsophomores?\b", re.I),
    "junior": re.compile(r"\bjuniors?\b", re.I),
    "senior": re.compile(r"\bseniors?\b", re.I),
}
# The common extractor deliberately groups aliases for matching, but a public 'mentioned' label
# must not turn '.NET' into C#, Jira into Agile, or the verb 'excel' into Microsoft Excel.
# These product names need unambiguous context; other names must appear literally as named facts.
_PRODUCT_SKILLS = {
    "Excel": r"\b(?:Microsoft|MS)\s+Excel\b",
    "React": r"\bReact(?:\.js|JS| Native)\b",
    "Swift": r"\bSwift(?:UI| programming| language)\b",
    "Spark": r"\b(?:Apache Spark|PySpark)\b",
}
_SKILLS = {name: re.compile(_PRODUCT_SKILLS.get(name,
            r"(?<![\w+#])" + re.escape(name) + r"(?![\w+#])"), re.I)
           for name in insights.PATTERNS}


def row_hash(row: dict) -> str:
    """Bind optional facts to the current role, destination and full-source insight contract."""
    fields = {key: row.get(key) for key in ("id", "company_name", "apply_url", "insights", "insights_text_version")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def checked_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def read_records(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read(MAX_SIDECAR_BYTES + 1)
        packed = json.loads(raw) if len(raw.encode("utf-8")) <= MAX_SIDECAR_BYTES else {}
    except (OSError, ValueError, UnicodeError, RecursionError):
        return {}
    return (packed["records"] if isinstance(packed, dict) and type(packed.get("version")) is int
            and packed["version"] == 1 and isinstance(packed.get("records"), dict) else {})


def record(row: dict, full_text: str) -> dict | None:
    """2026-10-28: capture bounded facts before the existing 1,500-character public text cap.

    Called on fetched full text, never on carried description excerpts. No prose is copied into
    the facts sidecar. Revert: omit the exporter call to stop creating records.
    """
    if (str(row.get("company_name") or "").casefold() not in COHORT_EMPLOYERS or row.get("status") != "open"
            or not str(row.get("apply_url") or "").startswith(("https://", "http://"))):
        return None
    facts = source_facts(row, full_text)
    if not facts:
        return None
    return {"version": 1, "row_sha256": row_hash(row), "source_url": row["apply_url"],
            "source_sha256": hashlib.sha256(full_text.encode()).hexdigest(), "source_chars": len(full_text),
            "checked_on": checked_day(), "facts": [list(f) for f in facts]}


def recorded_facts(row: dict, packet) -> tuple[tuple[str, str], ...]:
    """Changed insights/URL, old versions or malformed values invalidate the optional record."""
    if (not isinstance(packet, dict) or type(packet.get("version")) is not int or packet["version"] != 1
            or row.get("status") != "open"
            or str(row.get("company_name") or "").casefold() not in COHORT_EMPLOYERS
            or type(row.get("insights_text_version")) is not int or row["insights_text_version"] != INSIGHTS_VERSION
            or packet.get("row_sha256") != row_hash(row) or packet.get("source_url") != row.get("apply_url")
            or not isinstance(packet.get("source_sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", packet["source_sha256"])
            or type(packet.get("source_chars")) is not int or not 0 < packet["source_chars"] <= MAX_DESCRIPTION
            or not isinstance(packet.get("facts"), list) or len(packet["facts"]) > 3):
        return ()
    try:
        age = (date.fromisoformat(checked_day()) - date.fromisoformat(packet.get("checked_on"))).days
    except (TypeError, ValueError):
        return ()
    if not 0 <= age <= SOURCE_DAYS:
        return ()
    stored = row.get("insights")
    if not isinstance(stored, dict):
        return ()
    years, classes, skills = (stored.get(key) for key in ("grad_years", "class_standing", "skills"))
    allowed = {
        "Graduation years mentioned": {str(y) for y in (years if isinstance(years, list) else []) if type(y) is int},
        "Class years mentioned": {y for y in (classes if isinstance(classes, list) else []) if isinstance(y, str) and y in _CLASS},
        "Skills mentioned": {s.get("name") for s in (skills if isinstance(skills, list) else [])
                             if isinstance(s, dict) and isinstance(s.get("name"), str) and s["name"] in _SKILLS},
    }
    result = []
    for fact in packet["facts"]:
        if not isinstance(fact, list) or len(fact) != 2 or not all(isinstance(v, str) for v in fact):
            return ()
        label, value = fact
        values = value.split(", ")
        if label not in allowed or not value or len(value) > 200 or not set(values) <= allowed[label]:
            return ()
        if label == "Skills mentioned" and len(values) > MAX_SKILLS:
            return ()
        if any(label == previous[0] for previous in result):
            return ()
        result.append((label, value))
    return tuple(result)


def source_facts(row: dict, text: str) -> tuple[tuple[str, str], ...]:
    """Only literal, unnegated mentions that agree with both stored and freshly extracted insights.

    2026-10-28: 'mentioned' is deliberate: neither an extraction nor a short card is a complete
    eligibility decision. Never surface inferred class years, requirements strength, visa status,
    citizenship, GPA or deadlines here. Revert: return () to suppress these optional details.
    """
    stored = row.get("insights")
    if (type(row.get("insights_text_version")) is not int or row["insights_text_version"] != INSIGHTS_VERSION
            or not isinstance(stored, dict) or not isinstance(text, str)
            or not text.strip() or len(text) > MAX_DESCRIPTION):
        return ()
    # Independently require a direct positive source clause. This removes 'Python not required'
    # and stops the extractor's 'completed freshman year' inference being called a literal mention.
    chunks = [s.strip() for s in re.split(r"(?<=[.!?;])\s+|\n+", text) if s.strip()]
    positive = [s for s in chunks if not _NEGATIVE.search(s) and not _OTHER.search(s)]
    fresh = insights.extract(text)
    facts = []
    stored_years = stored.get("grad_years")
    if isinstance(stored_years, list):
        direct = {int(y) for s in positive if _GRADUATION.search(s)
                  for y in re.findall(r"\b20[2-3]\d\b", s)}
        years = sorted({y for y in stored_years if type(y) is int and y in direct
                        and y in fresh.get("grad_years", [])})
        if years:
            facts.append(("Graduation years mentioned", ", ".join(map(str, years))))
    stored_classes = stored.get("class_standing")
    if isinstance(stored_classes, list):
        classes = [name for name, rx in _CLASS.items() if name in stored_classes
                   and name in fresh.get("class_standing", [])
                   and any(rx.search(s) and re.search(r"\bstudents?\b|standing|undergraduat|\byear\b", s, re.I)
                           for s in positive)]
        if classes:
            facts.append(("Class years mentioned", ", ".join(classes)))
    stored_skills = stored.get("skills")
    if isinstance(stored_skills, list):
        named = {s.get("name") for s in stored_skills if isinstance(s, dict) and isinstance(s.get("name"), str)}
        current = {s["name"] for s in fresh.get("skills", [])}
        skills = sorted(name for name in named & current if name in _SKILLS
                        and any(_SKILLS[name].search(s) for s in positive))[:MAX_SKILLS]
        if skills:
            facts.append(("Skills mentioned", ", ".join(skills)))
    return tuple(facts)


def load(site_dir: str, rows: list[dict]) -> dict[str, tuple[tuple[str, str], ...]]:
    """Read only local description sidecars needed by the cohort's displayed roles, once per file.

    2026-10-28: no network calls, client payload, broad description copying or unbounded text reads.
    A missing/malformed/oversized sidecar omits optional details and cannot stop publication.
    Revert: return {} to keep the existing cards.
    """
    pending = {str(row["id"]): row for row in rows[:MAX_ROWS] if row.get("id") is not None}
    if not pending:
        return {}
    details = {}
    # Full-source facts are exported separately so slim dashboard rows and the 1,500-character
    # description limit stay unchanged. A new export replaces this map; carried excerpts cannot
    # recreate or silently refresh its provenance.
    records = read_records(os.path.join(site_dir, "data", FILE))
    for id_, row in list(pending.items()):
        facts = recorded_facts(row, records.get(id_))
        if facts:
            details[id_] = facts
            del pending[id_]
    for id_, row in list(pending.items()):
        if isinstance(row.get("description"), str) and row["description"].strip():
            facts = source_facts(row, row["description"])
            if facts:
                details[id_] = facts
            del pending[id_]
    candidates = {}
    for id_, row in pending.items():
        for key in row.get("keys", ()):
            if isinstance(key, str) and _SHARD.fullmatch(key):
                path = os.path.join(site_dir, "data", "listings", key + ".desc.json")
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue
                if size <= MAX_SIDECAR_BYTES:
                    candidates.setdefault((size, path), set()).add(id_)
    # Multi-state roles have the same description in several shards. Read smaller files first,
    # and stop considering a role once its available source text has been checked.
    for (_, path), ids in sorted(candidates.items()):
        ids = ids & pending.keys()
        if not ids:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                raw = f.read(MAX_SIDECAR_BYTES + 1)
            if len(raw.encode("utf-8")) > MAX_SIDECAR_BYTES:
                continue
            descriptions = json.loads(raw)
        except (OSError, ValueError, UnicodeError, RecursionError):
            continue
        if not isinstance(descriptions, dict):
            continue
        for id_ in sorted(ids):
            text = descriptions.get(id_)
            if not isinstance(text, str) or not text.strip():
                continue
            facts = source_facts(pending.pop(id_), text)
            if facts:
                details[id_] = facts
    return details
