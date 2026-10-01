"""Static, crawlable landing pages built from the exported listings.

The dashboard is a client-rendered app: a search engine that fetches internscout.org sees a shell and
no internships. These pages give every field, state, field-in-a-state and UMass major its own plain
HTML page listing the open postings, so a student searching "nursing internships massachusetts" can
land on one. They are rebuilt from docs/data on every deploy (see .github/workflows/pages.yml), so
they are always as fresh as the data and are never committed.

Quality rules, because mass-produced pages that say nothing are exactly what search engines demote:
  * a page exists only when it has at least MIN_OPEN open listings;
  * every sentence on it is computed from its own listings (counts, employers, pay, terms), never
    filler text, so two pages only read alike when their data is alike;
  * everything that came from a job board is HTML-escaped, and only http(s) links are ever emitted.

Run:  python -m internscout.seo_pages <site_dir>
      where <site_dir> is a copy of docs/ (it reads <site_dir>/data and writes into <site_dir>).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import quote

SITE = "https://internscout.org"
MIN_OPEN = 5            # no page for fewer open listings than this
# A field in one state needs more: at 5, 900 near-identical pages would be most of the site, the shape
# search engines treat as doorway pages. At 15 about 400 remain, each a list worth reading.
MIN_COMBO = 15
# ...counting only postings filed in fewer states than this. One employer posting the same role in
# 30 states would otherwise make 30 pages that differ only in the state's name.
SPREAD = 10


def keep_at(need: int) -> int:
    """A page that is already live stays until it falls to two thirds of what a new page needs, so a
    topic hovering at the line does not vanish and come back between deploys (a search engine that
    finds a URL gone drops it, and takes weeks to trust it again)."""
    return need * 2 // 3
# was: 10. Lowered 2026-10-01: Search Console showed "[employer] internships" is how people find the site,
# and since the employer pages carry the facts box and answers (employer_facts), a page with 5 roles
# still says something worth reading. 270 more employers qualified that day.
MIN_EMPLOYER = 5        # open roles an employer needs before it gets a page of its own
MIN_KIND = 25           # ...and a start term, paid, co-op, research or class-year page (see kinds())
PER_PAGE = 40           # listings shown on one page; the dashboard has the rest
NEW_DAYS = 7
RELATED = 12            # related-page links per section
NEW_FEED = 100          # items in /internships/new/feed.xml (the other feeds carry feeds.ITEMS)
TAIL = ", from internships to co-ops and research"     # how a page's opening sentence usually ends

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "Washington, DC", "FL": "Florida",
    "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin",
    "WY": "Wyoming", "PR": "Puerto Rico", "remote": "Remote (US)",
}
# Canada since 2026-09-30. A province is filed like a state (none of the codes is a US state's), and
# three more kinds of page are made from the same listings: all of Canada, and each big metro, since
# "internships in Toronto" is searched far more than "internships in Ontario". The metros are the
# ones geo.CA_METROS groups towns under; smaller ones still count toward their province.
CA_PROVINCES = {
    "ON": "Ontario", "QC": "Quebec", "BC": "British Columbia", "AB": "Alberta", "MB": "Manitoba",
    "SK": "Saskatchewan", "NS": "Nova Scotia", "NB": "New Brunswick", "NL": "Newfoundland and Labrador",
    "PE": "Prince Edward Island", "NT": "Northwest Territories", "NU": "Nunavut", "YT": "Yukon",
}
CA_METRO_PAGES = {"Toronto": "ON", "Montreal": "QC", "Vancouver": "BC", "Calgary": "AB", "Ottawa": "ON",
                  "Edmonton": "AB", "Waterloo Region": "ON"}
US_STATES.update(CA_PROVINCES)
US_STATES.update({"Canada": "Canada", **{m: m for m in CA_METRO_PAGES}})
CANADA_KEYS = set(CA_PROVINCES) | {"Canada"}
# was: set(US_STATES) - {"remote"}. "Canada" and the metros are views over the provinces, not places
# a posting is filed in, so they do not count toward how widely a posting is spread.
PLACES = set(US_STATES) - {"remote", "Canada"} - set(CA_METRO_PAGES)      # the states a posting can be filed in

# How a field tag reads in a heading and in a URL. Tags not listed read as their own words.
FIELD_TITLES = {
    "swe": ("Software Engineering", "software-engineering"),
    "ml": ("Machine Learning and AI", "machine-learning-ai"),
    "data": ("Data Science and Analytics", "data-science"),
    "pm": ("Product Management", "product-management"),
    "hr": ("Human Resources", "human-resources"),
    "quant": ("Quantitative Finance", "quantitative-finance"),
    "security": ("Cybersecurity", "cybersecurity"),
    "hardware": ("Hardware Engineering", "hardware-engineering"),
    "electrical": ("Electrical Engineering", "electrical-engineering"),
    "mechanical": ("Mechanical Engineering", "mechanical-engineering"),
    "civil": ("Civil Engineering", "civil-engineering"),
    "aerospace": ("Aerospace Engineering", "aerospace-engineering"),
    "chemical": ("Chemical Engineering", "chemical-engineering"),
    "industrial": ("Industrial Engineering", "industrial-engineering"),
    "environmental": ("Environmental Science and Engineering", "environmental"),
    "biomedical": ("Biomedical Engineering", "biomedical-engineering"),
    "materials": ("Materials Science", "materials-science"),
    "supply_chain": ("Supply Chain", "supply-chain"),
    "public_health": ("Public Health", "public-health"),
    "clinical_research": ("Clinical Research", "clinical-research"),
    "lab_research": ("Lab Research", "lab-research"),
    "real_estate": ("Real Estate", "real-estate"),
    "social_work": ("Social Work", "social-work"),
    "social_science": ("Social Science", "social-science"),
    "urban_planning": ("Urban Planning", "urban-planning"),
    "business": ("Business", "business"),
    "law": ("Law and Legal", "law"),
    "government": ("Government and Public Policy", "government"),
    "sports": ("Sports", "sports"),
    "arts": ("Arts", "arts"),
    "museums": ("Museums", "museums"),
    "library": ("Library Science", "library-science"),
}
SKIP_FIELDS = {"other"}


def field_title(tag: str) -> str:
    return FIELD_TITLES.get(tag, (tag.replace("_", " ").title(), None))[0]


SLUG_MAX = 80           # longest slug a URL folder gets (see slugify)


def slugify(text: str) -> str:
    """URL-safe words. A job board's company name can run to hundreds of characters, and a folder
    name past the filesystem's 255 bytes is an OSError that stopped the whole deploy. A long slug is
    cut to SLUG_MAX and ends in a hash of the whole one, so two long names that share their first 70
    characters still get two folders, and the same name gets the same folder on every build."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    # was: return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) <= SLUG_MAX:
        return slug
    return slug[:SLUG_MAX - 9].rstrip("-") + "-" + hashlib.sha1(slug.encode()).hexdigest()[:8]


def field_slug(tag: str) -> str:
    return FIELD_TITLES.get(tag, (None, None))[1] or slugify(tag)


def state_slug(key: str) -> str:
    return slugify(US_STATES.get(key, key))


esc = html.escape


def safe_url(url) -> str | None:
    u = (url or "").strip()
    return u if u.lower().startswith(("https://", "http://")) else None


# ---------------------------------------------------------------- data

_TEXT = (str, type(None))
_LIST_FIELDS = ("field_tags", "stage", "years")


def well_formed(x) -> bool:
    """Whether a listing has the shape every page builder reads without checking. pages.yml deploys
    through this build and nothing else, so one row a job board mangled (a region with no "loc", a
    company name that is a number, a tag list that is a string) used to stop the whole site from
    deploying. Such a row is left out and counted instead (load)."""
    if not isinstance(x, dict) or isinstance(x.get("id"), bool) or not isinstance(x.get("id"), (str, int)):
        return False
    if not all(isinstance(x.get(k), _TEXT) for k in ("company_name", "title", "first_seen", "posted_at")):
        return False
    if not isinstance(x.get("term"), _TEXT) or not isinstance(x.get("insights"), (dict, type(None))):
        return False
    if not all(isinstance(x.get(k) or [], list) and all(isinstance(v, str) for v in x.get(k) or [])
               for k in _LIST_FIELDS):
        return False
    regions = x.get("regions") or []
    return isinstance(regions, list) and all(
        isinstance(g, dict) and isinstance(g.get("loc"), _TEXT) and isinstance(g.get("state"), _TEXT)
        and bool(g.get("loc") or g.get("state")) for g in regions)


def load(site_dir: str) -> dict:
    data = os.path.join(site_dir, "data")
    with open(os.path.join(data, "listings", "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    with open(os.path.join(data, "majors.json"), encoding="utf-8") as f:
        majors = json.load(f)
    by_id: dict[str, dict] = {}
    bad = 0
    for key, meta in index["files"].items():
        with open(os.path.join(data, meta["file"]), encoding="utf-8") as f:
            rows = json.load(f)
        for x in rows if isinstance(rows, list) else []:
            if not well_formed(x):
                bad += 1
                continue
            if x.get("status") != "open" or not safe_url(x.get("apply_url")):
                continue
            keep = by_id.setdefault(str(x["id"]), dict(x, id=str(x["id"]), keys=set()))
            # was: keep = by_id.setdefault(x["id"], dict(x, keys=set()))
            keep["keys"].add(key)
    for x in by_id.values():
        # The Canada and metro pages' keys (the listing files are by province, with "Canada" for the
        # ones that name no province): every Canadian role is in "Canada", and in its metro's.
        regions = x.get("regions") or []
        if any(g.get("kind") == "canada" for g in regions if isinstance(g, dict)):
            x["keys"].add("Canada")
        x["keys"].update(g["metro"] for g in regions if isinstance(g, dict) and g.get("metro") in CA_METRO_PAGES)
    if bad:
        print(f"[seo] warning: skipped {bad} malformed listing rows (see well_formed)", file=sys.stderr)
    listings = list(by_id.values())
    return {"generated_at": index.get("generated_at"), "listings": listings,
            "majors": majors.get("majors", []), "baseline": baseline_day(listings)}


# first_seen has survived from one export to the next only since this day, so everything already
# open then carries it: 11,146 of 12,792 listings on 2026-09-23. Counted as "found this week", that
# made half the site new, and a brand post said 110 new data science roles when 31 were.
FIRST_SEEN_SINCE = "2026-09-18"


# Canada was switched on this day, and its first scan found about 800 Canadian roles that had been
# open for weeks. By first_seen alone 346 of them were "new this week". A Canadian role first seen on
# or before this day counts as new only if the employer's own posting date is inside the week; one
# first seen after it is new by the ordinary rule.
CANADA_SINCE = "2026-09-30"


def canada_first_scan(x: dict) -> bool:
    """A role only in Canada that the first Canadian scan found (see CANADA_SINCE)."""
    regions = [g for g in x.get("regions") or [] if isinstance(g, dict)]
    return (bool(regions) and all(g.get("kind") == "canada" for g in regions)
            and str(x.get("first_seen") or "")[:10] <= CANADA_SINCE)


def baseline_day(listings: list[dict]) -> str | None:
    """The day before which "first seen" means only "already open when we started keeping dates"."""
    return FIRST_SEEN_SINCE


def _when(stamp) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def newest_first(items: list[dict]) -> list[dict]:
    """The dashboard's order (docs/js/app.js, "newer"): dated postings first, newest posting first,
    then by when a scan found it. first_seen alone would put a 2024 posting found this week on top.
    Postings that tie on all three stay in id order, not in whatever order they arrived: which 40 a
    page shows must be the same on every build of the same data (test_two_builds_are_identical)."""
    return sorted(sorted(items, key=lambda x: str(x.get("id"))),
                  key=lambda x: (bool(x.get("posted_at")), x.get("posted_at") or "", x.get("first_seen") or ""),
                  reverse=True)      # sorted() stays stable under reverse=True, so ties keep id order
    # was: return sorted(items, key=lambda x: (...), reverse=True)   (ties in arrival order)


def top(counts: Counter, n: int | None = None) -> list:
    """Counter.most_common, but ties broken by the key itself. most_common breaks them by insertion
    order, and counting over a set inserts in hash order, which Python changes on every run: one
    employer page said "mostly in nonprofit, marketing and communications" on one build and
    "... communications and marketing" on the next."""
    return [k for k, _ in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]]


# A board with no pay to show still fills the field: "$0.00 /Yr", "$0.00 - $999.99 Hour" (22 open
# listings on 2026-09-25). A figure that is all zeros, or a range that starts at zero, says nothing.
_AMOUNT = re.compile(r"\d[\d,]*(?:\.\d+)?")


def placeholder_pay(salary) -> bool:
    nums = [float(n.replace(",", "")) for n in _AMOUNT.findall(str(salary or ""))]
    return bool(nums) and (nums[0] == 0 or not any(nums))


def real_salary(x: dict) -> str | None:
    """The listing's salary text, unless it is a placeholder (placeholder_pay)."""
    s = x.get("salary")
    return str(s) if s and not placeholder_pay(s) else None


def is_paid(x: dict) -> bool:
    # A placeholder salary is not pay. export_static used to turn one into insights.pay "paid" as
    # well, and an export made before that fix still carries it, so a placeholder settles it.
    if x.get("salary") and placeholder_pay(x["salary"]):
        return False
    return bool(x.get("salary")) or ((x.get("insights") or {}).get("pay") == "paid")
    # was: return bool(x.get("salary")) or ((x.get("insights") or {}).get("pay") == "paid")


def pay_text(x: dict) -> str:
    """What a listing row says about pay: the real salary, else "Paid" when the posting says so."""
    return real_salary(x) or ("Paid" if is_paid(x) else "")


def place(x: dict, state: str | None = None) -> str:
    """Where the role is. On a state's page, the location in that state comes first: a Massachusetts
    page that says "New York, NY +5" reads as a listing filed in the wrong place."""
    regions = x.get("regions") or []
    if not regions:
        return "Remote" if x.get("is_remote") else "United States"
    if state == "remote":
        lead = next((g for g in regions if g.get("kind") == "remote" or g.get("state") == "Remote"), regions[0])
    elif state:
        # was: g.get("state") == state. A metro page leads with the location in that metro, and the
        # Canada page with the Canadian one.
        lead = next((g for g in regions if g.get("state") == state or g.get("metro") == state
                     or (state == "Canada" and g.get("kind") == "canada")), regions[0])
    else:
        lead = regions[0]
    shown = "Remote" if lead.get("state") == "Remote" else (lead.get("loc") or lead.get("state") or "United States")
    # was: shown = "Remote" if lead.get("state") == "Remote" else lead["loc"]
    return shown + (f" +{len(regions) - 1}" if len(regions) > 1 else "")


# UMass Amherst students are the audience: roles within reach of western Massachusetts, and remote
# ones, are the ones they can take. Pages that span the country list those first.
HOME_STATES = {"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "remote"}


def fresh(x: dict, now: datetime, baseline: str | None = None) -> bool:
    """Found in the last NEW_DAYS, and not an old posting a scan has only just reached, nor one that
    was already open on the day first_seen began (baseline_day).

    Counted in calendar days (today is the data's UTC date, a stamp's day the day it names), the
    rule export_static.mark_new gives is_new, so the dashboard's "New" filter and /internships/new/
    agree. A rolling 7 x 24 hours made them differ by the roles
    found seven days ago later in the day than the run (1,834 here against 1,832 there). One
    difference is left: a listing with no first_seen is not new here and is there, but every
    exported row has one."""
    seen, posted = _when(x.get("first_seen")), _when(x.get("posted_at"))
    if baseline and str(x.get("first_seen") or "")[:10] <= baseline:
        return False
    today = now.astimezone(timezone.utc).date()
    if canada_first_scan(x):
        return bool(posted and (today - posted.date()).days < NEW_DAYS)
    return bool(seen and (today - seen.date()).days < NEW_DAYS
                and (posted is None or (today - posted.date()).days < 2 * NEW_DAYS))
    # was: seen and now - seen <= timedelta(days=NEW_DAYS)
    #      and (posted is None or now - posted <= timedelta(days=2 * NEW_DAYS))


def near_home_first(items: list[dict]) -> list[dict]:
    ordered = newest_first(items)
    return [x for x in ordered if x["keys"] & HOME_STATES] + [x for x in ordered if not x["keys"] & HOME_STATES]


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def lower_name(name: str) -> str:
    """A field title as it reads mid-sentence: "machine learning and AI", not "... and ai"."""
    return " ".join(w if len(w) > 1 and w.isupper() else w.lower() for w in name.split())


def join_words(words: list[str]) -> str:
    words = [w for w in words if w]
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1] if words else ""


# ---------------------------------------------------------------- page pieces

def summary(items: list[dict], what: str, where: str, tail: str = TAIL, about: frozenset = frozenset()) -> str:
    """The page's opening paragraph, every clause computed from its own listings. tail is "" where
    "from internships to co-ops and research" would contradict the page (the co-op page)."""
    n = len(items)
    parts = [f"{plural(n, 'open student role')} {what}{where}{tail}."]
    stages = Counter(s for x in items for s in x.get("stage") or [])
    # `about` names what the page is picked by (the co-op page is all co-ops, the paid page all paid):
    # counting that again would only repeat the heading.
    extra = [plural(stages[s], label) for s, label in
             (("co_op", "co-op"), ("research", "research position"), ("fellowship", "fellowship"),
              ("part_time", "part-time role")) if stages.get(s) and s not in about]
    if extra:
        parts.append(f"That includes {join_words(extra)}.")
    paid = sum(1 for x in items if is_paid(x))
    if paid and "paid" not in about:
        parts.append(f"{paid * 100 // n}% list pay or say they are paid.")
    # A bare season ("Summer") is a board that gave no year; beside "Summer 2027" it reads as a repeat.
    terms = Counter(x["term"] for x in items if x.get("term") and re.search(r"\d{4}|round", str(x["term"])))
    if terms and "term" not in about:
        common = top(terms, 2)       # was: [t for t, _ in terms.most_common(2)]
        parts.append(f"The most common start {'term is' if len(common) == 1 else 'terms are'} {join_words(common)}.")
    employers = top(Counter(x["company_name"] for x in items if x.get("company_name")), 5)
    # was: employers = [c for c, _ in Counter(x["company_name"] for x in items).most_common(5)]
    if len(employers) >= 3:
        parts.append(f"Employers with the most openings: {join_words(employers)}.")
    return " ".join(esc(p) for p in parts)


EMPLOYERS: dict[str, str] = {}   # every spelling of a company's name -> its employer page, set by build()

# Trailing words that name the same employer differently: "Magna International" is Magna, "The Boeing
# Company" is Boeing. Only whole trailing words go, so "Bank of America" keeps its name.
_SUFFIX = re.compile(r"\s+(inc|incorporated|llc|ltd|co|company|corp|corporation|international|group|holdings|plc|lp)$")
EMPLOYER_ALIASES = {"booz allen hamilton": "booz allen"}
STUDENT_STAGES = {"internship", "co_op", "research", "fellowship"}


def employer_key(name: str) -> str:
    k = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9& ]+", " ", name.lower())).strip()
    k = re.sub(r"^the ", "", k)
    while _SUFFIX.search(k):
        k = _SUFFIX.sub("", k).strip()
    return EMPLOYER_ALIASES.get(k, k) or name.lower()


def dedupe_roles(items: list[dict]) -> list[dict]:
    """One row per role: a company that posts a requisition on two of its boards (Boeing's
    JR2026520392 and JR2026520392-1) would otherwise count it twice in "N Open Now"."""
    seen, out = set(), []
    for x in newest_first(items):
        key = (re.sub(r"\W+", " ", (x.get("title") or "").lower()).strip(), place(x))
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out


def student_share(items: list[dict]) -> float:
    return sum(1 for x in items if set(x.get("stage") or []) & STUDENT_STAGES) / len(items) if items else 0.0


TERM = re.compile(r"^(Winter|Spring|Summer|Fall) (\d{4})$")
SEASONS = {"Winter": 0, "Spring": 1, "Summer": 2, "Fall": 3}


def kinds(listings: list[dict]) -> list[dict]:
    """The other ways students search, beside field, state, major and employer, each a volume Semrush
    measured on 2026-09-24 (US, monthly): a start term ("summer 2027 internships" 590, "summer
    internships" 5,400), "paid internships" 3,600, "co op jobs" 720, "research internships for
    undergraduates" 390 and "reu programs" 1,300, "freshman internships" and "sophomore internships"
    390 each. Every page is picked by the listings' own fields, so it lists only what its title says:
    a term page is the roles whose posting names that term, and a class-year page is the roles whose
    posting says it takes that year (most say nothing, and those stay off it)."""
    out = []
    for t in sorted({str(x.get("term")) for x in listings if TERM.match(str(x.get("term") or ""))},
                    key=lambda t: (TERM.match(t)[2], SEASONS[TERM.match(t)[1]])):
        out.append({"slug": slugify(t), "h1": f"{t} internships", "crumb": t, "what": f"starting {t}",
                    "title": f"{t} Internships – {{n}} Open Now",
                    "desc": f"{{n}} open {t} internships, co-ops and research roles for college students, "
                            "updated {updated}. Northeast and remote first. Free search, no sign-up.",
                    "pick": lambda x, t=t: x.get("term") == t, "dash": {}, "about": frozenset({"term"})})
    stage = lambda s: lambda x: s in (x.get("stage") or [])          # noqa: E731
    year = lambda y: lambda x: y in (x.get("years") or [])           # noqa: E731
    years_note = ("<p class=\"more\">Most postings don't say which class years they take, so this page is "
                  "only the ones that do. The dashboard's “Eligible year” filter keeps the rest as well.</p>")
    out += [
        {"slug": "paid", "h1": "Paid internships", "crumb": "Paid", "what": "that list pay or say they are paid",
         "title": "Paid Internships – {n} Open with Pay Listed",
         "desc": "{n} open internships, co-ops and research roles that list pay or say they are paid, updated "
                 "{updated}. Free search for college students, no sign-up.",
         "pick": is_paid, "dash": {"paid": True}, "about": frozenset({"paid"})},
        {"slug": "co-op", "h1": "Co-op jobs and internships", "crumb": "Co-ops", "what": "that are co-ops",
         "tail": "", "title": "Co-op Jobs and Internships – {n} Open",
         "desc": "{n} open co-ops for college students, updated {updated}. Northeast and remote first. "
                 "Free search, no sign-up.",
         "pick": stage("co_op"), "dash": {"stage": "co_op"}, "about": frozenset({"co_op"})},
        {"slug": "research", "h1": "Research internships for undergraduates", "crumb": "Research",
         "what": "in research", "tail": "", "title": "Research Internships for Undergraduates – {n} Open",
         "desc": "{n} open research positions for undergraduates, updated {updated}. Free search, no sign-up.",
         "note": "<p class=\"more\">Paid summer research programs (REUs) funded by the National Science "
                 "Foundation are listed on the <a href=\"https://www.nsf.gov/funding/initiatives/reu\">NSF's "
                 "REU page</a>; many apply through their own sites.</p>",
         "pick": stage("research"), "dash": {"stage": "research"}, "about": frozenset({"research"})},
        {"slug": "for-freshmen", "h1": "Internships for freshmen", "crumb": "Open to first-years",
         "what": "whose postings say they take first-year students",
         "title": "Internships for Freshmen – {n} Open to First-Years",
         "desc": "{n} open internships and programs whose postings say they take first-year college "
                 "students, updated {updated}. Free search, no sign-up.",
         "note": years_note, "pick": year("first_year"), "dash": {"year": "first_year"}},
        {"slug": "for-sophomores", "h1": "Internships for sophomores", "crumb": "Open to sophomores",
         "what": "whose postings say they take sophomores",
         "title": "Internships for Sophomores – {n} Open",
         "desc": "{n} open internships and programs whose postings say they take sophomores, updated "
                 "{updated}. Free search, no sign-up.",
         "note": years_note, "pick": year("sophomore"), "dash": {"year": "sophomore"}},
    ]
    return out


def shown(items: list[dict], state: str | None = None) -> list[dict]:
    """The PER_PAGE listings a page actually shows, in its order: what a reader, and a search engine,
    sees of it. Two pages that show the same ones are the same page to both (see same_list)."""
    return (newest_first(items) if state else near_home_first(items))[:PER_PAGE]


def shown_ids(items: list[dict]) -> frozenset:
    return frozenset(x["id"] for x in shown(items))


SAME_SHARE = 0.9    # a page that already shows this much of another's list is that page (same_list)


def same_list(owner: frozenset, mine: frozenset) -> bool:
    """Whether a page that would show `mine` is the page that already shows `owner`: the same
    listings, or at least SAME_SHARE of mine among them. A search engine picks one of two such pages
    and treats the other as a duplicate either way; folding it here decides which, and keeps one
    page's signals from being split across two URLs.

    The share is of the page being folded, which is the smaller one whenever the two differ in
    size. Folding a page into a smaller one would drop the listings only it shows (a major showing 40
    roles, 6 of them all a small field's page has), so a smaller owner never takes a bigger page."""
    return owner == mine or len(owner & mine) * 10 >= SAME_SHARE * 10 * len(mine)


def listing_rows(items: list[dict], now: datetime, state: str | None = None, here: str | None = None) -> str:
    rows = []
    for x in shown(items, state):
        # was: ordered = newest_first(items) if state else near_home_first(items)
        #      for x in ordered[:PER_PAGE]:
        new = fresh(x, now, BASELINE)
        stage = ", ".join(s.replace("_", "-") for s in (x.get("stage") or []) if s != "internship")
        meta = [esc(place(x, state))]
        if x.get("term"):
            meta.append(esc(str(x["term"])))
        if stage:
            meta.append(esc(stage))
        pay = esc(pay_text(x))       # was: esc(str(x["salary"])) if x.get("salary") else ("Paid" if is_paid(x) else "")
        new_tag = ' <span class="new">New</span>' if new else ""
        pay_tag = f' · <span class="pay">{pay}</span>' if pay else ""
        href = esc(safe_url(x["apply_url"]))
        rows.append(
            '<li class="job">'
            f'<div class="co">{company_link(x.get("company_name") or "", here)}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{" · ".join(meta)}{pay_tag}</div>'
            f'<a class="go" href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>'
            "</li>")
    return "\n".join(rows)


def company_link(name: str, here: str | None = None) -> str:
    """The company's name, linked to its employer page when it has one (here: this page's path)."""
    path = EMPLOYERS.get(name)
    return f'<a href="{esc(path)}">{esc(name)}</a>' if path and path != here else esc(name)


def link_list(title: str, links: list[tuple[str, str, int]]) -> str:
    if not links:
        return ""
    lis = "".join(f"<li><a href=\"{esc(href)}\">{esc(label)}</a> <span class=\"n\">{n:,}</span></li>"
                  for href, label, n in links)
    return f"<section class=\"rel\"><h2>{esc(title)}</h2><ul>{lis}</ul></section>"


# The dashboard's tokens (docs/index.html). accent-hover is the call-to-action's hover, a real colour
# step rather than a fade. nav spacing is a flex gap (was: margin-left on each link, which also pushed
# the first one off the header's edge when the header wrapped on a phone).
CSS = """
:root{--paper:#f6f4ef;--panel:#fffefb;--ink:#17191c;--ink2:#454a52;--ink3:#646a73;--rule:#e2ded4;
--accent:#1d5c46;--accent-soft:#e3eee8;--accent-hover:#164a38;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#131416;--panel:#1a1b1e;--ink:#ecebe6;--ink2:#b8b6af;
--ink3:#95948e;--rule:#2c2d31;--accent:#7cc3a1;--accent-soft:#1c2a24;--accent-hover:#95d2b3;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.6 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 64px}a{color:var(--accent)}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px 20px;flex-wrap:wrap;
padding:22px 0 14px;border-bottom:1px solid var(--ink)}
.mark{font:600 22px/1 "Source Serif 4",Georgia,serif;color:var(--ink);text-decoration:none}
nav{display:flex;gap:4px 14px;flex-wrap:wrap}
nav a{color:var(--ink2);font-size:14px;text-decoration:none;transition:color 140ms ease-out}nav a:hover{color:var(--ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.crumbs{font-size:14px;color:var(--ink3);margin:22px 0 0}.crumbs a{color:var(--ink3)}
h1{font:600 32px/1.2 "Source Serif 4",Georgia,serif;margin:10px 0 8px}
.lede{color:var(--ink2);font-size:17px;margin:0 0 6px}.updated{color:var(--ink3);font-size:14px;margin:0}
.cta{display:inline-block;margin:18px 0 8px;padding:10px 16px;border-radius:6px;background:var(--accent);
color:var(--paper);font-weight:600;text-decoration:none;transition:background-color 140ms ease-out}
.cta:hover{background:var(--accent-hover)}.cta:active{transform:translateY(1px)}
ul.jobs{list-style:none;padding:0;margin:24px 0;border-top:1px solid var(--rule)}
.job{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.co{font-weight:600}.role{grid-column:1}.meta{grid-column:1;color:var(--ink3);font-size:14px}
.pay{color:var(--ink2)}.new{font-size:12px;color:var(--accent);font-weight:600;margin-left:6px}
.go{grid-column:2;grid-row:1/span 3;align-self:center;font-size:14px;white-space:nowrap}
.more,.follow{color:var(--ink2)}section.rel h2{font:600 20px/1.3 "Source Serif 4",Georgia,serif;margin:36px 0 8px}
section.rel ul{list-style:none;padding:0;margin:0;columns:2;column-gap:28px}
section.rel li{padding:3px 0;break-inside:avoid}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:20px 0 24px;padding:16px 18px;
background:var(--panel);border:1px solid var(--rule);border-radius:8px}.facts dt{color:var(--ink3)}.facts dd{margin:0}
section.faq h2{font:600 18px/1.3 "Source Serif 4",Georgia,serif;margin:28px 0 6px}section.faq p{margin:0;color:var(--ink2)}
@media (max-width:560px){.facts{grid-template-columns:1fr;gap:2px}.facts dd{margin-bottom:8px}}.n{color:var(--ink3);font-size:13px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--ink3);font-size:14px}
footer a{color:var(--ink2)}@media (max-width:560px){h1{font-size:26px}section.rel ul{columns:1}
.job{grid-template-columns:1fr}.go{grid-column:1;grid-row:auto;margin-top:4px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.cta:active{transform:none}}
"""

def beacon_from(site_dir: str) -> str:
    """The analytics snippets exactly as the dashboard carries them, so there is one copy to change.
    (Its token is public by design, but a second hard-coded copy here could drift from the first.)
    Since 2026-09-30 that is two tags: the exact visit counter (js/count.js) and Cloudflare's beacon."""
    try:
        with open(os.path.join(site_dir, "index.html"), encoding="utf-8") as f:
            html = f.read()
    except OSError:
        return ""
    # was: one re.search for the cloudflareinsights tag
    tags = [re.search(r"<script[^>]*/js/count\.js[^>]*></script>", html),
            re.search(r"<script[^>]*cloudflareinsights[^>]*></script>", html)]
    return "\n".join(m.group(0) for m in tags if m)


BEACON = ""   # set by build() from the site's own index.html
BASELINE: str | None = None   # set by build(): see baseline_day
# set by build(): when the data was exported. Everything a build writes is dated from it, never from
# the clock, so two builds of the same data are the same bytes (the 404 page and every feed's
# lastBuildDate differed on each deploy).
GENERATED: datetime | None = None


def page(path: str, title: str, description: str, h1: str, crumbs: list[tuple[str, str]],
         body: str, updated: str, index: bool = True, feed: bool = False) -> str:
    url = SITE + path
    crumb_html = " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1]) + \
                 (f" › {esc(crumbs[-1][1])}" if crumbs else "")
    ld = {"@context": "https://schema.org", "@type": "BreadcrumbList",
          "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": t, "item": SITE + h}
                              for i, (h, t) in enumerate(crumbs)]}
    # "</" inside a script block would end it early, and so can "<!--" followed by "<script": an
    # employer named "<!--<script>" puts the parser in a state where the real </script> no longer
    # closes the block, and the page after it becomes script. So no "<", ">" or "&" appears in the
    # block at all: JSON reads <, > and & as the same characters, and they only ever
    # occur inside strings (they are not JSON punctuation), so replacing them is always safe.
    ld_json = (json.dumps(ld, ensure_ascii=False)
               .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    # was: ld_json = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
    # A breadcrumb trail of one is not a trail (Google reports it as invalid), so the hub has none.
    ld_tag = f'<script type="application/ld+json">{ld_json}</script>' if len(crumbs) > 1 else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}"/>
{f'<link rel="canonical" href="{esc(url)}"/>' if index else '<meta name="robots" content="noindex"/>'}
<meta property="og:title" content="{esc(title)}"/>
<meta property="og:description" content="{esc(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{esc(url)}"/>
<meta property="og:image" content="{SITE}/og-preview.png"/>
<meta name="twitter:card" content="summary_large_image"/>
{f'<link rel="alternate" type="application/rss+xml" title="{esc(h1)} | InternScout" href="feed.xml"/>' if feed else ""}
<link rel="icon" type="image/png" sizes="48x48" href="/icon48.png"/>
<link rel="apple-touch-icon" href="/icon128.png"/>
<style>{CSS}</style>
{ld_tag}
</head>
<body>
<div class="wrap">
<header><a class="mark" href="/">InternScout</a><nav><a href="/">Dashboard</a><a href="/internships/">Browse</a><a href="/install.html">Extension</a></nav></header>
<main>
<p class="crumbs">{crumb_html}</p>
<h1>{esc(h1)}</h1>
{body}
<p class="updated">Updated {esc(updated)}. Listings are collected from public job boards several times a day; always check the posting on the employer's site before applying.</p>
</main>
<footer><strong>Built by one student, made for all students.</strong> InternScout is a free internship search made by a UMass Amherst student. Not affiliated with UMass Amherst. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</div>
{BEACON}
</body>
</html>
"""


def _dash_state(state: str) -> str:
    """The dashboard has province files, not metro or all-Canada ones: a metro opens its province, and
    Canada every province and the no-province file."""
    if state == "Canada":
        return ",".join(list(CA_PROVINCES) + ["Canada"])
    return ",".join(CA_METRO_PAGES.get(s, s) for s in state.split(","))


def dash_link(fields=(), state: str | None = None, companies=(), new: bool = False,
              stage: str | None = None, year: str | None = None, paid: bool = False) -> str:
    """The dashboard, opened on this page's fields, states, employer, new roles, stage, class year or
    paid roles (docs/js/app.js reads ?field=, ?state=a,b, ?company=, ?new=1, ?stage=, ?year= and
    ?paid=1; its canonical link keeps these one page to search engines). An employer goes as an exact
    name, not a search: searching "Intel" also finds "intelligence", and "Texas Instruments" reads as
    a place."""
    q = [f"field={quote(','.join(fields), safe=',')}"] if fields else []
    if state:
        q.append(f"state={quote(_dash_state(state), safe=',')}")
    q += [f"company={quote(c)}" for c in companies]
    if new:
        q.append("new=1")
    q += [f"{k}={quote(v)}" for k, v in (("stage", stage), ("year", year)) if v]
    if paid:
        q.append("paid=1")
    return "/?" + "&amp;".join(q) if q else "/"


def fits_line(majors: list[str]) -> str:
    return (f"<p class=\"fits\">The page for {esc(join_words(sorted(majors)))} "
            f"{'majors' if len(majors) > 1 else 'majors too'}.</p>") if majors else ""


def listing_body(items: list[dict], what: str, where: str, now: datetime, related: str,
                 state: str | None = None, dash: str = "/", fits: list[str] | None = None,
                 here: str | None = None, tail: str = TAIL, about: frozenset = frozenset(), extra: str = "") -> str:
    more = len(items) - PER_PAGE
    order = "newest" if state else "newest, Northeast and remote first,"
    # `extra`: the employer pages' "at a glance" list, under the opening paragraph (2026-10-01).
    return (f"<p class=\"lede\">{summary(items, what, where, tail, about)}</p>" + fits_line(fits or []) + extra +
            f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
            f"<ul class=\"jobs\">{listing_rows(items, now, state, here)}</ul>"
            + (f"<p class=\"more\">Showing the {PER_PAGE} {order} of {len(items):,}. "
               f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>" if more > 0 else "")
            + "<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
              "<a href=\"feed.xml\">RSS feed</a></p>"
            # The extension has been in the Chrome Web Store since 2026-09-22. This links the install
            # page rather than the store: it's ours, so the link stays inside the site, and it tells a
            # phone reader to send it to a laptop instead of dropping them on a store page that can't
            # install anything. ?from= becomes the store link's utm_source there (install.html's
            # canonical link keeps it one page to search engines).
            + "<p class=\"follow\">Applying to a few? The free <a href=\"/install.html?from=landing-page\">Auto-Apply extension</a> "
              "fills in the application for you and stops at the submit button.</p>"
            + related)


# ---------------------------------------------------------------- employer pages
# Added 2026-10-01. Search Console showed the employer pages are what people find ("blue origin
# internships", "autozone internships"), at positions 6 to 12 with almost no clicks. A page that answers
# the follow-up questions (when, where, does it pay) from its own listings is worth more to a reader
# than a bare list, and its title can match "blue origin internships summer 2027". Every fact below is
# counted from the open roles; when the postings don't say, the page says that rather than guess.

_STATE_NAMES = {name: code for code, name in US_STATES.items() if len(code) == 2}
_HOURLY = re.compile(r"\b(hour|hr|hourly)\b", re.I)
_NOT_HOURLY = re.compile(r"\b(year|yr|annual|annually|month|week|stipend|salary)\b", re.I)


def long_day(stamp) -> str:
    d = _when(stamp)
    return f"{d:%B} {d.day}, {d.year}" if d else ""


def money(v: float) -> str:
    return f"${v:,.2f}".replace(".00", "")


def hourly_range(items: list[dict]) -> tuple[float, float, int] | None:
    """Lowest and highest hourly rate the postings list, and how many list one. A bare amount counts as
    hourly only under $200 (student pay quoted without a unit is an hourly rate); a yearly salary or a
    stipend is left out rather than turned into a made-up hourly figure."""
    lo = hi = None
    n = 0
    for x in items:
        s = real_salary(x)
        if not s or _NOT_HOURLY.search(s):
            continue
        nums = [float(a.replace(",", "")) for a in _AMOUNT.findall(s)]
        nums = [v for v in nums if 7 <= v < 200] if (_HOURLY.search(s) or all(v < 200 for v in nums)) else []
        if not nums:
            continue
        n += 1
        lo = min([*nums, *([lo] if lo is not None else [])])
        hi = max([*nums, *([hi] if hi is not None else [])])
    return (lo, hi, n) if n else None


def dated_terms(items: list[dict]) -> Counter:
    """Start terms that name a year ("Summer 2027"); a bare season is a board that gave none."""
    return Counter(x["term"] for x in items if x.get("term") and re.search(r"\d{4}", str(x["term"])))


def main_term(items: list[dict]) -> str | None:
    """The start term at least half the roles share, for the title; None when no one term does."""
    terms = dated_terms(items)
    if not terms:
        return None
    term, n = min(terms.items(), key=lambda kv: (-kv[1], kv[0]))
    return term if n * 2 >= len(items) else None


def place_name(g: dict) -> str:
    """One region as a reader names it: "Denver, CO", "Remote". "West Des Moines, Iowa" and
    "West Des Moines, IA" are one place, so a spelled-out state is shortened."""
    if g.get("kind") == "remote" or g.get("state") == "Remote":
        return "Remote"
    loc = str(g.get("loc") or g.get("state") or "").strip()
    # "New York, New York, United States" is "New York, NY": the country goes, then the state shortens.
    loc = re.sub(r",\s*(United States( of America)?|USA|US)$", "", loc).strip()
    m = re.match(r"^(.*),\s*([A-Za-z .]+)$", loc)
    if m and m.group(2).strip() in _STATE_NAMES:
        loc = f"{m.group(1)}, {_STATE_NAMES[m.group(2).strip()]}"
    return loc


def places(items: list[dict]) -> list[tuple[str, int]]:
    """Every place with open roles, most first; a role in three cities counts once in each."""
    c: Counter = Counter()
    for x in items:
        names = {place_name(g) for g in x.get("regions") or []} or ({"Remote"} if x.get("is_remote") else set())
        c.update(n for n in names if n)
    return sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))


def counted(pairs: list[tuple[str, int]], n: int) -> str:
    """ "Denver, CO (17), Huntsville, AL (13) and 4 more" """
    shown = [f"{name} ({k})" for name, k in pairs[:n]]
    rest = len(pairs) - n
    return join_words(shown + ([plural(rest, "more place")] if rest > 0 else []))


def employer_facts(name: str, items: list[dict], fields_main: list[str]) -> tuple[str, str]:
    """The "at a glance" list and the questions section for one employer's page, as HTML."""
    n = len(items)
    stages = Counter(s for x in items for s in x.get("stage") or [])
    kinds_ = [plural(stages[s], label) for s, label in (("internship", "internship"), ("co_op", "co-op"),
              ("research", "research position"), ("fellowship", "fellowship")) if stages.get(s)]
    terms = dated_terms(items)
    term_pairs = sorted(terms.items(), key=lambda kv: (-kv[1], kv[0]))
    where = places(items)
    remote = dict(where).get("Remote", 0)
    pay = hourly_range(items)
    paid = sum(1 for x in items if is_paid(x))
    posted = sorted(d for d in (_when(x.get("posted_at") or x.get("first_seen")) for x in items) if d)
    field_counts = Counter(t for x in items for t in set(x.get("field_tags") or []) if t in fields_main)

    rows = [("Open roles", f"{n:,}" + (f": {join_words(kinds_)}" if len(kinds_) > 1 else ""))]
    if term_pairs:
        rows.append(("Start", counted(term_pairs, 3).replace("more place", "more term")))
    if where:
        rows.append(("Where", counted(where, 3)))
    if pay:
        lo, hi, k = pay
        rows.append(("Listed pay", f"{money(lo)}{'' if lo == hi else ' to ' + money(hi)} an hour, on {k} of {n} roles"))
    else:
        rows.append(("Listed pay", "Not given in the postings" if not paid else f"{paid} of {n} roles say they are paid; no rate given"))
    if field_counts:
        rows.append(("Fields", join_words([f"{field_title(t)} ({field_counts[t]})" for t in fields_main if field_counts[t]])))
    if posted:
        rows.append(("Newest posting", long_day(posted[-1].isoformat())))
    facts = "<dl class=\"facts\">" + "".join(f"<dt>{esc(k)}</dt><dd>{esc(v)}</dd>" for k, v in rows) + "</dl>"

    qa = []
    dated = sum(terms.values())
    if term_pairs and dated * 2 < n:
        # Most postings give no term: say how few do, rather than call one "the most common".
        a = (f"Only {dated} of the {n} open roles {'gives' if dated == 1 else 'give'} a start term: "
             f"{join_words([t for t, _ in term_pairs[:4]])}. The rest don’t say.")
    elif term_pairs:
        top_term, top_n = term_pairs[0]
        a = (f"All {n} open roles start in {top_term}." if top_n == n else
             f"{top_term} is the most common start: {top_n} of the {n} open roles.")
        others = [t for t, _ in term_pairs[1:4]]
        if others:
            a += f" Others start in {join_words(others)}."
        unsaid = n - dated
        if unsaid:
            a += f" {unsaid} {'doesn’t' if unsaid == 1 else 'don’t'} say."
    else:
        a = "The open postings don’t give a start term. Each posting below has the details."
    qa.append((f"When do {name} internships start?", a))
    if where:
        a = f"The open roles are in {counted([w for w in where if w[0] != 'Remote'] or where, 5)}."
        if remote and len(where) > 1:
            a += f" {plural(remote, 'role')} can be done remotely."
        qa.append((f"Where are {name} internships?", a))
    if pay:
        lo, hi, k = pay
        a = (f"{k} of the {n} open roles list pay: {money(lo)} an hour." if lo == hi else
             f"{k} of the {n} open roles list pay, from {money(lo)} to {money(hi)} an hour.")
    elif paid:
        a = f"{paid} of the {n} open roles say they are paid, but the postings don’t give a rate."
    else:
        a = f"None of the {n} open postings lists pay."
    qa.append((f"Does {name} pay interns?", a))
    if posted:
        first, last = long_day(posted[0].isoformat()), long_day(posted[-1].isoformat())
        if posted[0].year == posted[-1].year:          # "September 1 and September 30, 2026"
            first = first.rsplit(",", 1)[0]
        a = (f"The open roles were posted on {last}." if first == last.rsplit(",", 1)[0] else
             f"The open roles were posted between {first} and {last}.")
        qa.append((f"When does {name} post internships?", a + " InternScout checks for new ones every day."))
    qa.append((f"How do I apply to {name}?",
               f"Every role on this page links to the application on {name}’s own site. "
               "InternScout doesn’t take applications or fees."))
    questions = ("<section class=\"faq\">" + "".join(f"<h2>{esc(q)}</h2><p>{esc(a)}</p>" for q, a in qa)
                 + "</section>")
    return facts, questions


# ---------------------------------------------------------------- build

def build(site_dir: str, live: dict[str, str] | set[str] | frozenset[str] = frozenset()) -> list[dict]:
    """live: the pages the site is serving now (live_paths), which get the lower keep_at bar and
    whose lastmod the new one never goes below."""
    global BEACON, BASELINE, GENERATED
    BEACON = beacon_from(site_dir)
    d = load(site_dir)
    BASELINE = d["baseline"]
    listings = d["listings"]
    now = _when(d["generated_at"]) or datetime.now(timezone.utc)
    GENERATED = now
    updated = f"{now:%B} {now.day}, {now.year}"
    pages: list[dict] = []

    by_field: dict[str, list] = {}
    by_state: dict[str, list] = {}
    # Sets are walked in sorted order everywhere below: a set of strings iterates in hash order, which
    # changes from one Python run to the next, and 170 of the pages came out different on two builds
    # of the same data (test_two_builds_are_identical).
    for x in listings:
        for t in sorted(set(x.get("field_tags") or []) - SKIP_FIELDS):   # was: in set(...) - SKIP_FIELDS
            by_field.setdefault(t, []).append(x)
        for k in sorted(x["keys"]):                                      # was: for k in x["keys"]:
            if k in US_STATES:
                by_state.setdefault(k, []).append(x)
    def enough(n: int, path: str, need: int = MIN_OPEN) -> bool:
        return n >= need or (path in live and n >= keep_at(need))

    fields = {t: v for t, v in by_field.items() if enough(len(v), f"/internships/{field_slug(t)}/")}
    states = {k: v for k, v in by_state.items() if enough(len(v), f"/internships/{state_slug(k)}/")}
    # A field slug and a state slug must never name the same folder.
    state_slugs = {state_slug(k) for k in states}
    fields = {t: v for t, v in fields.items() if field_slug(t) not in state_slugs}

    combos: dict[tuple[str, str], list] = {}
    for t, items in sorted(fields.items()):         # was: for t, items in fields.items():
        for k in sorted(states):                      # was: for k in states:
            hit = [x for x in items if k in x["keys"]]
            local = [x for x in hit if len(x["keys"] & PLACES) < SPREAD]
            if enough(len(local), f"/internships/{field_slug(t)}/{state_slug(k)}/", MIN_COMBO):
                combos[(t, k)] = hit

    # A major whose page would show what a field page, or an earlier major's page, already shows would
    # be a second URL for the same list. It gets no page of its own: the majors hub links it to that
    # page, and that page names it. "Shows" is the PER_PAGE listings on the page (shown), not every
    # listing behind it: matching only identical full lists let /internships/health/,
    # /for/nursing-majors/ and /for/nutrition-majors/ all show the same 40 postings, each its own
    # canonical page, because the majors pulled in a few more roles that never made the first 40.
    owners = [(shown_ids(v), f"/internships/{field_slug(t)}/") for t, v in sorted(fields.items())]
    # was: owner = {frozenset(x["id"] for x in v): f"/internships/{field_slug(t)}/" for t, v in fields.items()}
    major_rows, fits = [], {}
    for m in d["majors"]:
        tags = [t for t in m.get("tags") or [] if t not in SKIP_FIELDS]
        items = [x for x in listings if set(x.get("field_tags") or []) & set(tags)]
        if (m.get("level") not in (None, "undergrad")
                or not enough(len(items), f"/internships/for/{slugify(m['name'])}-majors/")):
            continue
        name = m["name"]
        mine = shown_ids(items)
        path = next((p for ids, p in owners if same_list(ids, mine)), None)
        if path is None:
            path = f"/internships/for/{slugify(name)}-majors/"
            owners.append((mine, path))
        # was: ids = frozenset(x["id"] for x in items)
        #      path = owner.setdefault(ids, f"/internships/for/{slugify(name)}-majors/")
        major_rows.append((m, tags, items, path))
        fits.setdefault(path, []).append(name)

    # Employers with enough open roles get a page ("Amgen internships" is a common search). Spellings
    # of one employer share a page (employer_key), a role posted on two boards counts once, and only
    # employers whose roles are mostly internships, co-ops, research or fellowships qualify: a
    # university's work-study board is jobs for its own students, not internships for everyone.
    global EMPLOYERS
    groups: dict[str, list] = {}
    for x in listings:
        if x.get("company_name"):
            groups.setdefault(employer_key(x["company_name"]), []).append(x)
    EMPLOYERS = {}
    by_company: dict[str, list] = {}      # display name -> its roles, one row each
    spellings: dict[str, list] = {}       # display name -> every name its listings use
    # Ties go to the key and to the name itself, so which spelling names the page, and which of two
    # employers whose names slug alike gets the folder, is the same on every build.
    for key, items in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):   # was: key=lambda kv: -len(kv[1])
        names = Counter(x["company_name"] for x in items)
        name = min(names, key=lambda n: (-names[n], len(n), n))                       # was: (-names[n], len(n))
        items = dedupe_roles(items)
        path = f"/internships/at/{slugify(name)}/"
        if (not slugify(name) or path in EMPLOYERS.values() or student_share(items) < 0.5
                or not enough(len(items), path, MIN_EMPLOYER)):
            continue
        by_company[name], spellings[name] = items, sorted(names)
        EMPLOYERS.update({n: path for n in names})

    def add(path, title, desc, h1, crumbs, body, items=None, state=None):
        # lastmod is the day the page's newest listing was found: it moves when the page gains a
        # listing, not on every deploy, which is the only lastmod a search engine keeps trusting.
        found = [str(x.get("first_seen") or "")[:10] for x in (listings if items is None else items)]
        # The live sitemap's lastmod is a floor: when the newest role on a page closes, the newest left
        # is older, and a lastmod that goes backwards is one a search engine stops trusting.
        found.append(live.get(path) or "" if isinstance(live, dict) else "")
        pages.append({"path": path, "html": page(path, title, desc, h1, crumbs, body, updated, feed=items is not None),
                      "items": items, "h1": h1, "state": state,
                      "lastmod": max((f for f in found if f), default=None)})

    root = ("/internships/", "Internships")
    page_name = {EMPLOYERS[nm]: nm for nm in by_company}     # employer page -> the name it goes by

    for t, items in sorted(fields.items()):
        name = field_title(t)
        path = f"/internships/{field_slug(t)}/"
        top_states = sorted(((k, len(v)) for (tt, k), v in combos.items() if tt == t), key=lambda kv: (-kv[1], kv[0]))
        # was: key=lambda kv: -kv[1]  (and so on below: every count that can tie is broken by name)
        related = link_list(f"{name} internships by state",
                            [(f"{path}{state_slug(k)}/", US_STATES[k], n) for k, n in top_states])
        emp = join_words(top(Counter(x["company_name"] for x in items if x.get("company_name")), 3))
        # was: emp = join_words([c for c, _ in Counter(x["company_name"] for x in items).most_common(3)])
        # The employers in this field that have a page of their own (2026-10-01), so search engines
        # reach the employer pages from the field pages as well as from single listing rows.
        hiring = Counter(EMPLOYERS[x["company_name"]] for x in items if x.get("company_name") in EMPLOYERS)
        related += link_list(f"Employers hiring in {lower_name(name)}",
                             [(pth, page_name[pth], k) for pth, k in sorted(hiring.items(), key=lambda kv: (-kv[1], kv[0]))[:RELATED]])
        add(path, f"{name} Internships – {len(items):,} Open Now | InternScout",
            f"{len(items):,} open {lower_name(name)} internships and co-ops for college students, updated "
            f"{updated}. Employers include {emp}. Free search, no sign-up.",
            f"{name} internships", [root, (path, name)],
            listing_body(items, f"in {lower_name(name)}", "", now, related, dash=dash_link([t]), fits=fits.get(path)), items)

    for k, items in sorted(states.items()):
        where = US_STATES[k]
        path = f"/internships/{state_slug(k)}/"
        top_fields = sorted(((t, len(v)) for (t, kk), v in combos.items() if kk == k), key=lambda tv: (-tv[1], tv[0]))
        related = link_list(f"Internships in {where} by field",
                            [(f"/internships/{field_slug(t)}/{state_slug(k)}/", field_title(t), n)
                             for t, n in top_fields])
        loc = "remote" if k == "remote" else f"in {where}"
        add(path, f"Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout",
            f"{len(items):,} open internships, co-ops and research roles {loc}, updated {updated}. "
            "Free search for college students, no sign-up.",
            f"Internships {'you can do remotely' if k == 'remote' else 'in ' + where}", [root, (path, where)],
            listing_body(items, "", f" {loc}", now, related, state=k, dash=dash_link(state=k)), items, k)

    for (t, k), items in sorted(combos.items()):
        name, where = field_title(t), US_STATES[k]
        path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
        others = sorted(((kk, len(v)) for (tt, kk), v in combos.items() if tt == t and kk != k), key=lambda kv: (-kv[1], kv[0]))
        related = link_list(f"{name} internships in other states",
                            [(f"/internships/{field_slug(t)}/{state_slug(kk)}/", US_STATES[kk], n)
                             for kk, n in others[:RELATED]])
        loc = "remote" if k == "remote" else f"in {where}"
        add(path, f"{name} Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout",
            f"{len(items):,} open {lower_name(name)} internships and co-ops {loc}, updated {updated}. "
            "Free search for college students, no sign-up.",
            f"{name} internships {loc}",
            [root, (f"/internships/{field_slug(t)}/", name), (path, where)],
            listing_body(items, f"in {lower_name(name)}", f" {loc}", now, related, state=k, dash=dash_link([t], k)), items, k)

    majors_made = []
    for m, tags, items, path in major_rows:
        name = m["name"]
        majors_made.append((path, name, len(items)))
        if path != f"/internships/for/{slugify(name)}-majors/":
            continue                 # folded into the field or major page with the same listings
        rel_tags = [t for t in (m.get("related") or []) if t in fields]
        related = link_list(f"Related fields for {name} majors",
                            [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t])) for t in rel_tags[:RELATED]])
        add(path, f"Internships for {name} Majors – {len(items):,} Open | InternScout",
            f"{len(items):,} open internships, co-ops and research roles that fit {name} majors, updated "
            f"{updated}. Built for UMass Amherst students; free, no sign-up.",
            f"Internships for {name} majors",
            [root, ("/internships/for/", "By major"), (path, name)],
            listing_body(items, f"that fit {name} majors", "", now, related, dash=dash_link(tags),
                         fits=[n for n in fits[path] if n != name]), items)

    # Each employer's main fields, for "Similar employers": others that hire in the same fields.
    company_fields = {nm: top(Counter(t for x in its for t in set(x.get("field_tags") or []) - SKIP_FIELDS), 3)
                      for nm, its in by_company.items()}

    for name, items in sorted(by_company.items()):
        path = EMPLOYERS[name]
        main = company_fields[name]
        # was: top = [t for t, _ in Counter(t for x in items for t in set(...) - SKIP_FIELDS).most_common(3)]
        covered = sum(1 for x in items if set(x.get("field_tags") or []) & set(main))
        fields_words = join_words([lower_name(field_title(t)) for t in main])
        # "Mostly" only when it is true; otherwise the fields are some of what the employer hires for.
        about = (f", mostly in {fields_words}" if covered * 2 > len(items) else
                 f", including roles in {fields_words}") if main else ""
        note = (f"<p class=\"more\">InternScout is not affiliated with {esc(name)}. These are roles InternScout "
                f"found on {esc(name)}'s public job boards; always apply on the employer's own site.</p>")
        facts, questions = employer_facts(name, items, main)
        # Ranked by fields shared, then size; the tie goes to the name, so every build agrees.
        similar = sorted(((len(set(main) & set(f)), len(by_company[o]), o) for o, f in company_fields.items()
                          if o != name and set(main) & set(f)), key=lambda t: (-t[0], -t[1], t[2]))[:RELATED]
        # was: related = note + link_list("Related fields", ...)
        related = (questions + note
                   + link_list("Similar employers", [(EMPLOYERS[o], o, k) for _, k, o in similar])
                   + link_list("Related fields", [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t]))
                                                  for t in main if t in fields]))
        # was: if k in US_STATES, which now holds the Canada and metro views as well.
        where = ",".join(top(Counter(k for x in items for k in x["keys"] if k in PLACES or k == "remote"), 6))
        # was: ",".join(k for k, _ in Counter(k for x in items for k in x["keys"] if k in US_STATES).most_common(6))
        # was: f"{name} Internships – {len(items):,} Open Now | InternScout", and a description of
        # "N open internships and co-ops at X for college students{about}". The start term in the title
        # matches "blue origin internships summer 2027"; places and pay are what a searcher picks on.
        term = main_term(items)
        top_places = [p for p, _ in places(items) if p != "Remote"][:3]
        pay = hourly_range(items)
        co_ops = sum(1 for x in items if "co_op" in (x.get("stage") or []))
        desc = (f"{len(items):,} open {name} internships{' and co-ops' if co_ops else ''}"
                + (f" for {term}" if term else "")
                + (f" in {join_words(top_places)}" if top_places else "") + "."
                + (f" Listed pay {money(pay[0])}{'' if pay[0] == pay[1] else '–' + money(pay[1])}/hour." if pay else
                   f" Roles in {fields_words}." if main else "")
                + f" Updated {updated}. Free, no sign-up.")
        add(path, f"{name} Internships{f' ({term})' if term else ''} – {len(items):,} Open | InternScout",
            desc,
            f"Internships at {name}", [root, ("/internships/at/", "By employer"), (path, name)],
            listing_body(items, f"at {name}", "", now, related,
                         dash=dash_link(state=where, companies=spellings[name]), here=path, extra=facts), items)

    # Start term, paid, co-op, research and class-year pages (kinds()). A slug a field or state page
    # already uses is skipped, like a field slug that names a state.
    taken = {p["path"] for p in pages}
    kind_made = []
    for k in kinds(listings):
        path = f"/internships/{k['slug']}/"
        items = [x for x in listings if k["pick"](x)]
        if path not in taken and enough(len(items), path, MIN_KIND):
            kind_made.append((path, k, items))
    for path, k, items in kind_made:
        by_tag = Counter(t for x in items for t in set(x.get("field_tags") or []) - SKIP_FIELDS if t in fields)
        related = (k.get("note", "")
                   + link_list(f"{k['h1'][0].upper()}{k['h1'][1:]} by field",
                               [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t]))
                                for t in top(by_tag, RELATED)])     # was: for t, _ in top.most_common(RELATED)
                   + link_list("More ways to browse", [(p, kk["h1"][0].upper() + kk["h1"][1:], len(v))
                                                       for p, kk, v in kind_made if p != path]))
        n = f"{len(items):,}"
        add(path, k["title"].format(n=n) + " | InternScout", k["desc"].format(n=n, updated=updated),
            k["h1"], [root, (path, k["crumb"])],
            listing_body(items, k["what"], "", now, related, dash=dash_link(**k["dash"]),
                         tail=k.get("tail", TAIL), about=k.get("about", frozenset())), items)

    new = [x for x in listings if fresh(x, now, d["baseline"])]
    if len(new) >= MIN_OPEN:
        add("/internships/new/", f"New Internships This Week – {len(new):,} Found | InternScout",
            f"{len(new):,} internships, co-ops and research roles for college students found in the last week, "
            f"Northeast and remote first. Updated {updated}. Free, no sign-up.",
            "New internships this week", [root, ("/internships/new/", "New this week")],
            listing_body(new, "found in the last week", "", now,
                         "<p class=\"more\">One feed for a whole club: this page's RSS feed carries the "
                         f"{NEW_FEED} newest roles found this week, so a Discord or Slack channel can follow "
                         "just this one.</p>",
                         dash=dash_link(new=True)), new)
        # More than the usual newest 25, since this one feed may be a club's only one, but not every
        # new role: that was 1,800 items and 800 KB, fetched every few hours by every subscriber.
        pages[-1]["feed_limit"] = NEW_FEED        # was: None (every new role)

    # Hubs last, so they only link to pages that exist.
    add("/internships/at/", f"Internships by Employer – {len(by_company):,} Employers | InternScout",
        f"Open internships and co-ops at {len(by_company):,} employers hiring college students now, from each "
        "employer's public job board. Free, no sign-up.",
        "Internships by employer", [root, ("/internships/at/", "By employer")],
        f"<p class=\"lede\">Employers with about {MIN_EMPLOYER} or more open student roles, most of them "
        "internships, co-ops or research. InternScout is not affiliated with any of them.</p>"
        + link_list("Employers", sorted(((EMPLOYERS[n], n, len(v)) for n, v in by_company.items()),
                                        key=lambda e: (e[1].lower(), e[1]))))   # was: key=lambda e: e[1].lower()
    add("/internships/for/", f"Internships by Major – {len(majors_made)} Majors | InternScout",
        "Open internships, co-ops and research roles for every UMass Amherst major, from nursing and "
        "sport management to engineering and finance. Free, no sign-up.",
        "Internships by major", [root, ("/internships/for/", "By major")],
        "<p class=\"lede\">Pick your major to see open roles that fit it. Each page counts only what is "
        "open today.</p>" + link_list("Majors", sorted(majors_made, key=lambda p: (p[1], p[0]))))
    hub = (f"<p class=\"lede\">{len(listings):,} open internships, co-ops, research positions and "
           "fellowships for college students, collected from employer job boards and public programs. "
           "Browse by field, by state or by major, or open the dashboard to rank them for you.</p>"
           "<p>Every page below has an RSS feed of its new listings (the link at the bottom of the page). "
           "Paste it into a Discord feed bot such as MonitoRSS, or Slack's <code>/feed subscribe</code>, "
           "and new roles appear in your club's channel as they are found.</p>"
           "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
           + link_list("By field", sorted(((f"/internships/{field_slug(t)}/", field_title(t), len(v))
                                          for t, v in fields.items()), key=lambda p: p[1]))
           # was: one "By state" list of every state page
           + link_list("By state", sorted(((f"/internships/{state_slug(k)}/", US_STATES[k], len(v))
                                          for k, v in states.items() if k not in CANADA_KEYS and k not in CA_METRO_PAGES),
                                         key=lambda p: p[1]))
           + link_list("Canada", [(f"/internships/{state_slug(k)}/", US_STATES[k], len(states[k]))
                                  for k in ["Canada", *CA_METRO_PAGES, *CA_PROVINCES] if k in states])
           + "<section class=\"rel\"><h2>More ways to browse</h2><ul><li><a href=\"/internships/for/\">"
             f"All {len(majors_made)} majors</a></li><li><a href=\"/internships/at/\">All {len(by_company):,} employers"
             "</a></li>" + (f"<li><a href=\"/internships/new/\">New this week</a> <span class=\"n\">{len(new):,}</span></li>"
                            if len(new) >= MIN_OPEN else "")
           + "".join(f"<li><a href=\"{p}\">{esc(k['h1'][0].upper() + k['h1'][1:])}</a> "
                     f"<span class=\"n\">{len(v):,}</span></li>" for p, k, v in kind_made)
           + "</ul></section>")
    add("/internships/", f"Browse {len(listings):,} Open Internships by Field, State and Major | InternScout",
        f"{len(listings):,} open internships, co-ops and research roles for college students, updated "
        f"{updated}. Browse by field, state or major. Free, no sign-up.",
        "Browse internships", [root], hub)
    return pages


def not_found(updated: str) -> str:
    """GitHub Pages serves 404.html for any missing path, including a landing page whose listings
    closed. Without it a visitor from an old search result gets GitHub's own page, with no way back."""
    body = ("<p class=\"lede\">This page isn't here. If it listed internships, they may have closed "
            "since it was made.</p>"
            "<p><a class=\"cta\" href=\"/internships/\">Browse open internships</a></p>"
            "<p>Or <a href=\"/\">open the dashboard</a> to search every listing.</p>")
    return page("/404.html", "Page not found | InternScout", "This page is not on InternScout.",
                "Page not found", [], body, updated, index=False)


def write(site_dir: str, pages: list[dict]) -> None:
    for p in pages:
        folder = os.path.join(site_dir, p["path"].strip("/").replace("/", os.sep))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "index.html"), "w", encoding="utf-8", newline="\n") as f:
            f.write(p["html"])
    now = GENERATED or datetime.now(timezone.utc)     # was: now = datetime.now(timezone.utc)
    with open(os.path.join(site_dir, "404.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(not_found(f"{now:%B} {now.day}, {now.year}"))
    # The dashboard changes with every data refresh; the other static pages carry no lastmod rather
    # than a made-up one.
    hub = next((p["lastmod"] for p in pages if p["path"] == "/internships/"), None)
    urls = [("/", hub), ("/install.html", None), ("/privacy", None), ("/terms", None)] + \
           [(p["path"], p.get("lastmod")) for p in pages]
    with open(os.path.join(site_dir, "sitemap.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u, mod in urls:
            f.write(f"  <url><loc>{esc(SITE + u)}</loc>" + (f"<lastmod>{mod}</lastmod>" if mod else "") + "</url>\n")
        f.write("</urlset>\n")
    with open(os.path.join(site_dir, "robots.txt"), "w", encoding="utf-8", newline="\n") as f:
        # No "Disallow: /data/": the dashboard at / (canonical, and in the sitemap) fetches its listings
        # from ./data/ in the browser, and a crawler barred from them renders it as an empty shell. The
        # files there are JSON, which search engines do not list as pages anyway.
        f.write(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
        # was: f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
        #              f"Disallow: /data/\n\nSitemap: {SITE}/sitemap.xml\n")


def live_paths(sitemap: str) -> dict[str, str]:
    """path -> lastmod ("" if none) for every page in the sitemap the site was serving before this
    build; empty if there was none."""
    try:
        with open(sitemap, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return {}
    return {SITE_PATH.sub("", loc): mod for loc, mod in
            re.findall(r"<loc>([^<]+)</loc>(?:<lastmod>([^<]*)</lastmod>)?", text)}


SITE_PATH = re.compile("^" + re.escape(SITE))


def main(argv: list[str]) -> None:
    site_dir = argv[1] if len(argv) > 1 else "docs"
    pages = build(site_dir, live_paths(argv[2]) if len(argv) > 2 else {})
    write(site_dir, pages)
    from . import feeds            # feeds imports this module, so not at the top
    # The date is passed, not left to feeds to read from seo_pages.GENERATED: run as
    # `python -m internscout.seo_pages` this module is __main__, and the internscout.seo_pages that
    # feeds imports is a second copy whose build() never ran, so its GENERATED is None.
    feeds.write_all(site_dir, pages, GENERATED)     # was: feeds.write_all(site_dir, pages)
    print(f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt into {site_dir}")


if __name__ == "__main__":
    main(sys.argv)
