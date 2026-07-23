"""Turn a raw posting (any source) into a normalized dict ready for persistence."""
from __future__ import annotations
import re
from datetime import datetime, timezone
from .classify import classify, is_internship
from .geo import evaluate_locations

_SEASON_RE = re.compile(r"\b(summer|fall|winter|spring)\b", re.I)
_YEAR_RE = re.compile(r"\b(20[2-3]\d)\b")  # 2020-2039, avoids matching job-id digits


def parse_term_from_text(text: str):
    """Best-effort (season, year) from a title/description. Either may be None."""
    text = text or ""
    m = _SEASON_RE.search(text)
    y = _YEAR_RE.search(text)
    season = m.group(1).capitalize() if m else None
    year = int(y.group(1)) if y else None
    return season, year

_SALARY_RE = re.compile(
    r'\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?'
    r'(?:\s?(?:[-\u2013]|to)\s?\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?)?'
    r'(?:\s?(?:/|per\s)?\s?(?:hour|hr|year|yr|annum|annually|month|mo|week|wk|day))?',
    re.I)
_DURATION_RE = re.compile(r'\b(\d{1,2})\s?[-\u2013]?\s?week', re.I)


def extract_salary(text: str):
    text = text or ""
    for m in _SALARY_RE.finditer(text):
        val = re.sub(r"\s+", " ", m.group(0)).strip()
        low = val.lower()
        has_unit = any(u in low for u in ("hour", "hr", "year", "yr", "annum", "month", "mo", "week", "wk", "day", "k"))
        digits = re.sub(r"[^\d]", "", val.split("-")[0])
        if has_unit or (digits.isdigit() and int(digits) >= 1000):
            return val[:120]
    return None


def extract_duration(text: str):
    m = _DURATION_RE.search(text or "")
    return f"{m.group(1)} weeks" if m else None

_WS = re.compile(r"\s+")
_NOISE = re.compile(r"[\(\)\[\]\-–—:,/|]+")
_SUFFIX = re.compile(
    r"\b(summer|fall|winter|spring)\b|\b20\d\d\b|\bintern(ship)?\b|\bco-?op\b|"
    r"\b(us|usa|remote|hybrid|onsite)\b|\b(i{1,3}|iv)\b", re.I
)


def normalize_title(title: str) -> str:
    t = title.lower()
    t = _SUFFIX.sub(" ", t)
    t = _NOISE.sub(" ", t)
    return _WS.sub(" ", t).strip()


def make_dedupe_key(company: str, title: str, season: str | None, year: int | None) -> str:
    return f"{company.strip().lower()}|{normalize_title(title)}|{(season or '').lower()}|{year or ''}"


def _to_dt(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    return ts


def normalize(raw: dict) -> dict | None:
    """raw fields expected: company_name, title, locations[list], season, year,
    apply_url, source, source_url, posted_at, active(bool), description(optional).

    Returns normalized dict, or None if it should be discarded (not an internship
    or off-target field)."""
    title = (raw.get("title") or "").strip()
    company = (raw.get("company_name") or "").strip()
    if not title or not company:
        return None
    if not is_internship(title, raw.get("employment_type", "")):
        return None

    tags = classify(title)  # title-only: avoids off-target tags from JD boilerplate
    if not tags:
        return None

    _blob = f"{title} {raw.get('description','') or ''}"
    geo = evaluate_locations(raw.get("locations") or [])
    season = raw.get("season")
    year = raw.get("year")
    # A year/season stated in the posting title is authoritative for that posting and
    # overrides the source's default cycle mapping (e.g. title "Summer 2026" beats 2027).
    # Precedence for term: an explicit season/year in the TITLE is most authoritative,
    # then the apply URL (many ATS slugs encode e.g. "2026-Summer-Intern"), then the
    # source's default cycle mapping.
    ps, py_ = parse_term_from_text(f"{title} {raw.get('description','') or ''}")
    us, uy = parse_term_from_text(raw.get("apply_url") or raw.get("url") or "")
    season = ps or us or season or raw.get("season")
    year = py_ or uy or year or raw.get("year")
    term = f"{season} {year}".strip() if season else None

    return {
        "company_name": company,
        "title": title,
        "description": raw.get("description"),
        "field_tags": tags,
        "season": season,
        "year": year,
        "term": term,
        "employment_type": "internship",
        "salary": raw.get("salary") or extract_salary(_blob),
        "duration": extract_duration(_blob),
        "locations": raw.get("locations") or [],
        "geo": geo,
        "location_raw": geo["location_raw"],
        "lat": geo["lat"], "lng": geo["lng"],
        "is_remote": geo["is_remote"],
        "within_radius": geo["within_radius"],
        "distance_miles": geo["best_distance"],
        "apply_url": raw.get("apply_url") or raw.get("url"),
        "posted_at": _to_dt(raw.get("posted_at") or raw.get("date_posted")),
        "active": raw.get("active", True),
        "source": raw.get("source", "github"),
        "source_url": raw.get("source_url") or raw.get("url"),
        "dedupe_key": make_dedupe_key(company, title, season, year),
    }
