"""Turn a raw posting (any source) into a normalized dict ready for persistence."""
from __future__ import annotations
import hashlib
import re
from datetime import datetime, timezone
from .classify import classify, stage_of, SECTOR_FIELDS, employer_research_field
from .region import evaluate_locations

# "Spring Boot" and "fall under" are not terms
# ...and neither are "Silver Spring, MD", "Cold Spring Harbor", "Fall River, MA" or "Winter Park, FL":
# a posting in Silver Spring was being given the term "Spring", and then dropped as out of cycle.
_SEASON_RE = re.compile(r"\b(summer|fall(?!\s+(?:under|within|into|in|on|behind|short|outside|off|river)\b)|autumn|"
                        r"winter(?!\s+(?:park|haven|garden|springs)\b)|"
                        r"(?<!silver\s)(?<!cold\s)spring(?!\s*(?:boot|framework|mvc|cloud|batch|data|hill|valley|lake|house|harbor)\b)(?!,\s*tx\b)|"
                        r"year[- ]round|academic year)\b", re.I)
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

# A season and a year written next to each other ("Summer 2027", "2027 Summer"). This is the only
# form a DESCRIPTION is trusted for: a lone year in one is as likely to be "founded in 2021" or
# "graduating in 2028" as the term, and it used to override the title.
_TERM_PAIR_RE = re.compile(
    r"\b(summer|fall|autumn|winter|spring)\s+(?:of\s+)?(20[2-3]\d)\b|\b(20[2-3]\d)\s+(summer|fall|autumn|winter|spring)\b", re.I)


def parse_term_pair(text: str):
    """(season, year) only when the two are written together; (None, None) otherwise."""
    for m in _TERM_PAIR_RE.finditer(text or ""):
        word, year = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        return _SEASON_NAME.get(word.lower(), word.capitalize()), int(year)
    return None, None


_GRAD_CONTEXT = re.compile(r"(graduat\w*|class of|degree|enrolled|completion|founded|since|established|copyright|\(c\))[^.]{0,40}$", re.I)


def lone_description_year(text: str, today: datetime | None = None):
    """A year standing alone in a description, if it can only be the term's year.

    "Our summer interns start in June 2027" is worth having; "founded in 2021", "graduating in
    2028" and "(c) 2025" are not. So the year has to be this year or next, and must not follow a
    graduation or founding word in the same sentence.
    """
    now = (today or datetime.now(timezone.utc)).year
    for m in _YEAR_RE.finditer(text or ""):
        y = int(m.group(1))
        if now <= y <= now + 1 and not _GRAD_CONTEXT.search(text[max(0, m.start() - 60):m.start()]):
            return y
    return None


_SALARY_RE = re.compile(
    r'\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?'
    r'(?:\s?(?:[-\u2013]|to)\s?\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?)?'
    r'(?:\s?(?:/|per\s)?\s?(?:hour|hr|year|yr|annum|annually|month|mo|week|wk|day))?',
    re.I)
_DURATION_RE = re.compile(r'\b(\d{1,2})\s?[-\u2013]?\s?week', re.I)


# The first dollar figure in a posting is often not the pay: "401(k) match up to $5,000", "$2,500
# tuition reimbursement", "$250,000 donated", "$3 billion in assets". A card that says an intern
# earns $250,000 is worse than a card that says nothing, so a figure is skipped when the words just
# before it are about benefits or the company, or when it is followed by million/billion; and a
# figure with no unit (no /hr, /year, k) is believed only when pay words are close by.
_NOT_PAY_BEFORE = re.compile(r"(401\s?\(?k\)?|match|bonus|tuition|reimburs\w*|relocation|scholarship|award\w*|grant\w*|"
                             r"revenue|funding|raised|donat\w*|assets|valuation|prize|referral|"
                             r"sign[- ]on|signing|discount)[^.$]{0,40}$", re.I)
_NOT_PAY_AFTER = re.compile(r"^\s?(million|billion|trillion|mm\b|m\b|b\b|bn\b|\+?\s?(in|of)\s+(assets|revenue|sales|funding))", re.I)
_PAY_NEAR = re.compile(r"(salary|pay\b|paid|compensation|wage|rate|range|stipend|earn|hourly|annual|base|per hour)", re.I)


def _is_pay(text: str, m, has_unit: bool) -> bool:
    before, after = text[max(0, m.start() - 60):m.start()], text[m.end():m.end() + 30]
    if _NOT_PAY_AFTER.search(after) or _NOT_PAY_BEFORE.search(before):
        return False
    return has_unit or bool(_PAY_NEAR.search(text[max(0, m.start() - 80):m.end() + 40]))


def extract_salary(text: str):
    text = text or ""
    for m in _SALARY_RE.finditer(text):
        val = re.sub(r"\s+", " ", m.group(0)).strip()
        low = val.lower()
        has_unit = any(u in low for u in ("hour", "hr", "year", "yr", "annum", "month", "mo", "week", "wk", "day", "k"))
        digits = re.sub(r"[^\d]", "", val.split("-")[0])
        if (has_unit or (digits.isdigit() and int(digits) >= 1000)) and _is_pay(text, m, has_unit):
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


_US_CODES = frozenset(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm "
                       "ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc pr").split())
_ROLE_WORD = re.compile(r"\b(interns?|internship|co-?op|engineer(?:ing)?|analyst|student|research(?:er)?|program|"
                        r"assistant|associate|developer|scientist|trainee|fellow(?:ship)?|apprentice)\b")


def _strip_title_loc(t: str) -> str:
    """Take a trailing "City, ST" off a lower-cased title, without taking the job with it.

    _TITLE_LOC alone reads any two letters after a comma as a state and up to three words before
    it as a city, so "Research, ML" and "Summer 2027 Student Intern, AI" normalized to nothing and
    "Marketing Intern, NY" lost its only words; every such title at one company then shared a
    dedupe key and merged into one row. Two checks: the code has to be a real state, and if the
    "city" holds a job word, only the ", ST" goes.
    """
    m = _TITLE_LOC.search(t)
    if not m:
        return t
    tail = m.group(0).rstrip()
    if tail[-2:] not in _US_CODES:
        return t
    if _ROLE_WORD.search(tail):
        return re.sub(r",\s*[a-z]{2}\s*$", " ", t)
    return t[:m.start()] + " "


def normalize_company(name: str) -> str:
    n = (name or "").lower()
    n = _COMPANY_STRIP.sub(" ", n)
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def normalize_title(title: str) -> str:
    t = title.lower()
    t = _TITLE_TAILS.sub(" ", t)
    t = _strip_title_loc(t)   # was _TITLE_LOC.sub(" ", t); see _strip_title_loc for why
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
    u = (url or "").strip().lower()
    # The dashboard puts apply_url straight into an href, and several sources are lists anyone can
    # edit. A link that is not plain http(s) - javascript:, data:, a bare path - is never a job page,
    # so it is dropped here rather than trusted to every page that renders it. (Added 2026-09 audit;
    # no listing had one at the time. An empty url is still allowed, as before.)
    if u and not u.startswith(("http://", "https://")):
        return True
    return "workforcenow.adp.com" in u and "recruitment.html" in u and "cid=" not in u


# Some boards shout: USAJOBS sends every federal title in capitals ("STUDENT TRAINEE (ACCOUNTING)",
# "PHYSICAL SCIENTIST (ENVIRONMENTAL)"), and so do a few employers ("INTERN - SOCIAL WORK (MSW/MA) -
# UNPAID"). 89 open listings in one export, and in a list of mixed-case titles they read as alarms.
# Only a title with no lower-case letter at all is touched, so a deliberate "IT Intern" or "Summer
# Analyst - IBD" is left exactly as the employer wrote it. The listing id hashes the lower-cased
# title, so it does not move.
_KEEP_CAPS = frozenset("""
    AI AWS CAD CEO CFO CNA CS DOD DOE EE EHS EMT ER GIS GS HR HVAC IBD ICU II III IT IV LPN MA MBA
    ME ML MS MSW NASA NY NYC PHD PR QA RN ROTC SQL STEM UI US USA UX VA
""".split())
_SMALL = frozenset("a an and as at by for in of on or the to with".split())
_WORD = re.compile(r"[A-Za-z][A-Za-z']*")


def readable_title(title: str) -> str:
    """An all-capitals title in title case, keeping acronyms. Anything else unchanged."""
    if not title or any(ch.islower() for ch in title) or sum(ch.isalpha() for ch in title) < 6:
        return title

    def word(m: re.Match) -> str:
        w = m.group(0)
        if w in _KEEP_CAPS or len(w) == 1 or not re.search(r"[AEIOUY]", w):
            return w                   # an acronym, an initial, or a vowel-less "MSW" / "HR"
        if w.lower() in _SMALL and m.start() > 0:
            return w.lower()
        return w.capitalize()

    return _WORD.sub(word, title)


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
    if tags == ["other"] and employer_research_field(company, title):
        tags = [employer_research_field(company, title)]
    if tags == ["other"] and raw.get("field_hint"):   # a source that knows the field, e.g. a USAJOBS series
        tags = [raw["field_hint"]]
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
    # The title and the description used to be read as one string, so the first year anywhere in
    # the description won: "Software Intern" at a company "founded in 2021" became Summer 2021 and
    # was dropped as a past cycle. Now the title speaks first, then the URL, and the description is
    # believed only where it writes a season and a year together, and only if that season agrees
    # with the one already found. A season word alone in the description still counts, as before,
    # and a year alone in it counts only when lone_description_year says it can be the term's.
    #   was: ps, py_ = parse_term_from_text(f"{title} {description}")
    desc = raw.get("description", "") or ""
    ts, ty = parse_term_from_text(title)
    us, uy = parse_term_from_text(raw.get("apply_url") or raw.get("url") or "")
    ds, dy = parse_term_pair(desc)
    ls, _ = parse_term_from_text(desc)
    ps = ts or us or ds or ls
    if ds and ps != ds:
        dy = None
    py_ = ty or uy or dy or lone_description_year(desc)
    season = ps or season or raw.get("season")
    year = py_ or year or raw.get("year")
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
        "title": readable_title(title),
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
