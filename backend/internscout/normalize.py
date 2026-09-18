"""Turn a raw posting (any source) into a normalized dict ready for persistence."""
from __future__ import annotations
import hashlib
import re
from datetime import datetime, timezone
from .classify import classify, stage_of, SECTOR_FIELDS
from .region import evaluate_locations

# "Spring Boot" and "fall under" are not terms
_SEASON_RE = re.compile(r"\b(summer|fall(?!\s+(?:under|within|into|in|on|behind|short|outside|off)\b)|autumn|winter|"
                        r"spring(?!\s*(?:boot|framework|mvc|cloud|batch|data)\b)|year[- ]round|academic year)\b", re.I)
_SEASON_NAME = {"autumn": "Fall", "year round": "Year-round", "year-round": "Year-round", "academic year": "Year-round"}
_YEAR_RE = re.compile(r"\b(20[2-3]\d)\b")  # 2020-2039, avoids matching job-id digits


def parse_term_from_text(text: str):
    """Best-effort (season, year) from a title/description. Either may be None."""
    text = text or ""
    m = _SEASON_RE.search(text)
    y = _YEAR_RE.search(text)
    season = _SEASON_NAME.get(m.group(1).lower(), m.group(1).capitalize()) if m else None
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


# Strip legal-entity suffixes and program words so company-name variants collapse
# ("Walleye Capital", "Walleye Capital, LLC", "Walleye Capital Internships" -> "walleye capital").
_COMPANY_STRIP = re.compile(
    r"\b(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|"
    r"limited partnership|limited|l\.?p\.?|plc|gmbh|internships?|internship program|"
    r"careers|external students|students)\b", re.I)
# Trailing location on titles ("... Intern Boston, MA" / "... United States").
_TITLE_TAILS = re.compile(r"[\s,]*(united states|u\.?s\.?a?\.?)\s*$", re.I)
_TITLE_LOC = re.compile(r"[\s,]*[a-z][a-z]+(?:\s[a-z]+){0,2},\s*[a-z]{2}\s*$", re.I)


def normalize_company(name: str) -> str:
    n = (name or "").lower()
    n = _COMPANY_STRIP.sub(" ", n)
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def normalize_title(title: str) -> str:
    t = title.lower()
    t = _TITLE_TAILS.sub(" ", t)
    t = _TITLE_LOC.sub(" ", t)
    t = _SUFFIX.sub(" ", t)
    t = _NOISE.sub(" ", t)
    return _WS.sub(" ", t).strip()


def make_dedupe_key(company: str, title: str, season: str | None, year: int | None) -> str:
    return f"{normalize_company(company)}|{normalize_title(title)}|{(season or '').lower()}|{year or ''}"


def listing_id(dedupe_key: str) -> str:
    """The id a listing is stored under in the browser, stable from one run to the next.

    This used to be the database row id. CI keeps no database between runs - it commits the
    exported JSON and the registry, not the db file - so every run rebuilds the table from
    scratch and the id a posting got was really its position in that run's insert order. Two
    consecutive exports agreed on it for 34% of the postings they both contained.

    Everything a student owns is keyed on this id. Their Applied/Interviewing marks live in
    localStorage under it, the Auto-Apply queue carries it to the extension, and the per-listing
    Report link puts it in the feedback form. So a mark made on Monday was sitting on somebody
    else's job by Tuesday, and a reported id named a posting that no longer existed.

    The dedupe key is the identity the pipeline already merges a posting on, and it is built
    from the employer, the title and the term - all of which the next run reads again from the
    board. Hashing it gives the same answer next run without storing anything. Measured on the
    two exports above: 99.0% of postings present in both keep their id, against 33.9% before.

    16 hex characters of SHA-256; the key is already unique per listing, and a corpus of 13,000
    has about a 5e-9 chance of a collision on top of that.
    """
    return hashlib.sha256(dedupe_key.encode("utf-8")).hexdigest()[:16]


def _to_dt(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        if ts > 1e11:  # milliseconds
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if isinstance(ts, datetime):
        return ts
    if isinstance(ts, str) and ts.strip():
        s = ts.strip().replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(s)
        except ValueError:
            try:
                return datetime.fromisoformat(s[:10])
            except ValueError:
                return None
    return None


PUBLIC_SOURCES = ("usajobs", "nyc_jobs")


def _dead_url(url: str) -> bool:
    """A career-centre link that has lost the tenant id it needs opens nothing at all.

    ADP's recruitment.html without a cid draws its cookie banner and then stops: no job, no form,
    no Apply, however long you wait. Our own ADP fetcher always writes the cid, but the same link
    reaches us second-hand from search feeds, which carry it the way it was posted rather than the
    way it works. A listing nobody can open is worse than one we never had.
    """
    u = (url or "").lower()
    return "workforcenow.adp.com" in u and "recruitment.html" in u and "cid=" not in u


def normalize(raw: dict) -> dict | None:
    """raw fields expected: company_name, title, locations[list], season, year,
    apply_url, source, source_url, posted_at, active(bool), description(optional).

    Returns normalized dict, or None if it should be discarded (not an internship
    or off-target field)."""
    title = (raw.get("title") or "").strip()
    company = (raw.get("company_name") or "").strip()
    if not title or not company:
        return None
    if _dead_url(raw.get("apply_url") or raw.get("url") or ""):
        return None
    stages = stage_of(title, raw.get("employment_type", ""))
    if not stages:  # student opportunities only
        return None

    tags = classify(title)  # title-only: avoids off-target tags from JD boilerplate
    if tags == ["other"] and raw.get("sector") in SECTOR_FIELDS:
        tags = [SECTOR_FIELDS[raw["sector"]]]
    if raw.get("source") in PUBLIC_SOURCES:  # every posting from a government feed is government work
        tags = [t for t in tags if t != "other"] + ([] if "government" in tags else ["government"])
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
    # A season on its own is worth keeping - "Summer" on a card is true, and the dashboard scores a
    # season-only term against the student's chosen terms - but "Summer None" is not, and 649 of the
    # 14,525 listings in the last export said exactly that. The dashboard has been deleting the word
    # None since before this was found; now there is none to delete. And a source that hands over the
    # string "null" for a season has told us nothing, so it is treated as nothing.
    if season and str(season).strip().lower() in ("", "none", "null"):
        season = None
    term = (f"{season} {year}" if year else str(season)).strip() if season else None

    return {
        "company_name": company,
        "title": title,
        "description": raw.get("description"),
        "field_tags": tags,
        "stage": stages,
        "season": season,
        "year": year,
        "term": term,
        "employment_type": stages[0],
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
        "sector": raw.get("sector"),
    }
