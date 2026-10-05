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
from statistics import median
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

SITE = "https://internscout.org"
# In all advertising copy, and so in every page's footer and in llms.txt (one copy, added 2026-10-02).
SLOGAN = "Built by one student, made for all students."
# The extension's Chrome Web Store listing, the same URL docs/install.html links (2026-10-04).
STORE_URL = "https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi"
# The listings' "ats" values whose application sites are in extension/manifest.json host_permissions,
# so Auto-Apply fills them with no extra permission (jazzhr applies on applytojob.com). Left out:
# "other" and "icims_site", whose employers' own domains are only optional permissions there.
# tests/test_seo_pages.py checks each one against the manifest.
SUPPORTED_ATS = frozenset({"workday", "greenhouse", "oracle", "icims", "ashby", "lever", "eightfold",
                           "smartrecruiters", "successfactors", "taleo", "bamboohr", "rippling", "jazzhr",
                           "workable", "jobvite", "recruitee", "adp", "paylocity"})
# The hosts those systems apply on, as extension/lib/hosts.js ATS_HOSTS lists them (the manifest's
# host_permissions). The "ats" alone is not enough (2026-10-04): an employer can serve its SuccessFactors
# or Greenhouse board from its own domain (careers.qorvo.com, careers.withwaymo.com), and there the
# extension has to ask the student for that one site first. autofills() wants both.
AUTOFILL_HOSTS = ("myworkdayjobs.com", "myworkdaysite.com", "greenhouse.io", "lever.co", "ashbyhq.com",
                  "smartrecruiters.com", "oraclecloud.com", "icims.com", "taleo.net", "workable.com",
                  "rippling.com", "bamboohr.com", "jobvite.com", "recruitee.com", "adp.com",
                  "successfactors.com", "paylocity.com", "applytojob.com", "eightfold.ai")
# The free monthly Auto-Apply allowance. Must match worker/src/config.js: TASKS[task].allowance for a
# school .edu account, and GENERAL_ALLOWANCE_PCT (50, rounded down) of it for any other email.
FREE_EDU = {"autofill": 25, "resume_tailor": 10}
FREE_GENERAL = {"autofill": 12, "resume_tailor": 5}
MIN_OPEN = 5           # no page for fewer open listings than this
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


def listing_rows(items: list[dict], now: datetime, state: str | None = None, here: str | None = None,
                 src: str = "seo-field") -> str:
    """src: where the page sits (seo-employer, seo-state, ...), carried into the install page's ?from=
    by each row's "Auto-Apply this" link, so its store link's utm_source says which pages install."""
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
        # On a site Auto-Apply fills, a quiet second link to the install page (2026-10-04). Internal,
        # so a page of 40 rows is not 40 outbound store links; the page's one store link is autoapply_card.
        aa = (f' <a class="aa" href="/install.html?from={esc(src)}-row">Auto-Apply this</a>'
              if autofills(x) else "")
        rows.append(
            '<li class="job">'
            f'<div class="co">{company_link(x.get("company_name") or "", here)}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{" · ".join(meta)}{pay_tag}</div>'
            f'<a class="go" href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>{aa}'
            "</li>")
    return "\n".join(rows)


def autofills(x: dict) -> bool:
    """Whether Auto-Apply fills this listing's application with no extra permission: a system it knows,
    on that system's own host (extension/lib/hosts.js isAtsHost). 2026-10-04."""
    if x.get("ats") not in SUPPORTED_ATS:
        return False
    host = (urlparse(x.get("apply_url") or "").hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in AUTOFILL_HOSTS)


def autoapply_card(items: list[dict], src: str, state: str | None = None) -> str:
    """What the free extension would do for the roles this page lists, counted from them (2026-10-04):
    "12 of these 40 applications are on Workday, Greenhouse or another site ...". Nothing when none of
    them is on a site it fills. Two buttons, one shown: on a computer straight to the store (count.js
    counts it as install_click), on a phone or tablet, which can't add extensions, to the install page,
    which says to send the link to a laptop. The same media query as install.html's, so no script."""
    rows = shown(items, state)
    on = Counter(x["ats"] for x in rows if autofills(x))
    # was: ... if x.get("ats") in SUPPORTED_ATS (counted SuccessFactors boards on employers' own domains)
    n, m = sum(on.values()), len(rows)
    if not n:
        return ""
    # Workday first when the page has it (the one students know by name), then by count.
    named = [ATS_NAMES.get(k, k) for k in sorted(on, key=lambda k: (k != "workday", -on[k], k))]
    if len(named) == 1:
        where = f"{named[0]}, a site"
    elif len(named) == 2:
        where = f"{named[0]} or {named[1]}, sites"
    else:
        where = f"{named[0]}, {named[1]} or another site"
    who = ("This application is" if m == 1 else f"All {m} of these applications are") if n == m else \
          f"{n} of these {m} applications {'is' if n == 1 else 'are'}"
    label = "Add Auto-Apply to Chrome, free"
    return (f"<div class=\"aa-card\"><p>{who} on {esc(where)} the free Auto-Apply extension can fill in from "
            f"your resume. It stops at Submit: you review {'it' if n == 1 else 'each one'} and send it yourself.</p>"
            f"<a class=\"cta ext-desk\" href=\"{STORE_URL}?utm_source={esc(src)}\">{label}</a>"
            f"<a class=\"cta ext-touch\" href=\"/install.html?from={esc(src)}\">{label}</a></div>")


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
.tablewrap{overflow-x:auto;margin:16px 0 8px}table.data{width:100%;border-collapse:collapse;font-size:15px}
table.data th,table.data td{text-align:left;vertical-align:top;padding:9px 14px 9px 0;border-bottom:1px solid var(--rule)}
table.data thead th{border-bottom:1px solid var(--ink);font-weight:600}table.data td.num{white-space:nowrap}
section.prose h2{font:600 22px/1.3 "Source Serif 4",Georgia,serif;margin:34px 0 6px}.src{color:var(--ink3);font-size:14px}
table.cmp{min-width:620px}@media (max-width:560px){table.data{font-size:14px}table.data th,table.data td{padding-right:10px}}
.aa-card{margin:18px 0 0;padding:14px 18px 6px;background:var(--panel);border:1px solid var(--rule);border-radius:8px}
.aa-card p{margin:0;color:var(--ink2)}.aa-card .cta{margin:10px 0 8px}
figure.chart{margin:8px 0 18px}figure.chart img{display:block;max-width:100%;height:auto}
figure.chart figcaption{color:var(--ink3);font-size:14px;margin-top:4px}
.ext-touch{display:none}@media (pointer:coarse) and (hover:none){.ext-desk{display:none}.ext-touch{display:inline-block}}
.aa{grid-column:2;align-self:start;font-size:13px;color:var(--ink3);white-space:nowrap}
.job:has(.aa) .go{grid-row:1/span 2;align-self:end}
@media (max-width:560px){.aa{grid-column:1;margin-top:6px}.job:has(.aa) .go{grid-row:auto}}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0 6px}
.tier{position:relative;display:flex;flex-direction:column;padding:20px 18px 16px;background:var(--panel);
border:1px solid var(--rule);border-radius:10px}.tier.pick{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.tier h2{font:600 20px/1.2 "Source Serif 4",Georgia,serif;margin:0}
.tier .price{font:600 30px/1.1 "Source Serif 4",Georgia,serif;margin:8px 0 2px}
.tier .price span{font:14px/1 "IBM Plex Sans",system-ui,sans-serif;color:var(--ink3)}
.tier .blurb{color:var(--ink2);margin:0 0 10px;font-size:15px}
.tier ul{margin:0 0 14px;padding-left:18px;color:var(--ink2);font-size:15px;flex:1}.tier li{margin:4px 0}
.tier .cta{margin:0;text-align:center}
.badge{position:absolute;top:-11px;left:16px;background:var(--accent);color:var(--paper);font-size:12px;
font-weight:600;padding:3px 9px;border-radius:999px}
.anchor{font-size:17px;margin:20px 0 0}ul.plain{padding-left:18px;color:var(--ink2)}ul.plain li{margin:6px 0}
@media (max-width:720px){.tiers{grid-template-columns:1fr}}
"""
# The last eleven lines (2026-10-05) are /pricing/: three tier cards in a row, the recommended one
# ringed in the accent with a "Most popular" badge, stacked on a phone.
# The last five lines (2026-10-02) are the tables and headed sections of /compare/ and
# /internships/highest-paying/. A wide table scrolls inside .tablewrap, never the page; the
# comparison's four wordy columns keep a readable width on a phone and scroll there instead.
# The six after them (2026-10-04) are autoapply_card and a row's "Auto-Apply this" link. The card's
# store button shows on a computer and its install-page button on a phone or tablet (install.html's
# query: touch is the primary input and nothing hovers). A row with the link moves "Open posting" up
# so the two stack in the right-hand column; on a phone both go under the row's text, 8px apart so a
# thumb meant for "Open posting" doesn't land on the install page (was: 2px, the grid gap).

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
# set by build(): llms.txt and llms-full.txt (llms_files), which write() puts at the site's root.
TEXTS: dict[str, str] = {}


def ld_script(obj) -> str:
    """One JSON-LD block, safe to put in a page whatever its strings hold.

    "</" inside a script block would end it early, and so can "<!--" followed by "<script": an
    employer named "<!--<script>" puts the parser in a state where the real </script> no longer
    closes the block, and the page after it becomes script. So no "<", ">" or "&" appears in the
    block at all: JSON reads <, > and & as the same characters, and they only ever
    occur inside strings (they are not JSON punctuation), so replacing them is always safe."""
    ld_json = (json.dumps(obj, ensure_ascii=False)
               .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    # was: ld_json = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">{ld_json}</script>'


def page(path: str, title: str, description: str, h1: str, crumbs: list[tuple[str, str]],
         body: str, updated: str, index: bool = True, feed: bool = False, ld: tuple | list = ()) -> str:
    """ld: more JSON-LD objects for the head (added 2026-10-02: the Organization, WebSite and
    FAQPage blocks of the hub and /about/), each in its own block after the breadcrumb trail."""
    url = SITE + path
    crumb_html = " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1]) + \
                 (f" › {esc(crumbs[-1][1])}" if crumbs else "")
    trail = {"@context": "https://schema.org", "@type": "BreadcrumbList",
             "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": t, "item": SITE + h}
                                 for i, (h, t) in enumerate(crumbs)]}
    # A breadcrumb trail of one is not a trail (Google reports it as invalid), so the hub has none.
    # (The escaping that was here is ld_script's, since 2026-10-02.)
    ld_tag = "\n".join(([ld_script(trail)] if len(crumbs) > 1 else []) + [ld_script(o) for o in ld])
    # was: ld_tag = f'<script type="application/ld+json">{ld_json}</script>' if len(crumbs) > 1 else ""
    # The footer links /about/ and /compare/ from every page (2026-10-02), so crawlers and answer
    # engines reach the pages that say what InternScout is. was: only Privacy and Terms.
    # The header names what the install page offers and that it costs nothing (2026-10-04).
    # was: <a href="/install.html">Extension</a>
    # Pricing, Compare and About are in the nav since 2026-10-05 (the audit: the comparison page, the
    # site's best price story, was reachable only from the footer, and the prices had no page at all).
    # was: <nav><a href="/">Dashboard</a><a href="/internships/">Browse</a><a href="/install.html">Auto-Apply (free)</a></nav>
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
<header><a class="mark" href="/">InternScout</a><nav><a href="/">Dashboard</a><a href="/internships/">Browse</a><a href="/install.html">Auto-Apply (free)</a><a href="/pricing/">Pricing</a><a href="/compare/">Compare</a><a href="/about/">About</a></nav></header>
<main>
<p class="crumbs">{crumb_html}</p>
<h1>{esc(h1)}</h1>
{body}
<p class="updated">Updated {esc(updated)}. Listings are collected from public job boards several times a day; always check the posting on the employer's site before applying.</p>
</main>
<footer><strong>{SLOGAN}</strong> InternScout is a free internship search made by a UMass Amherst student. Not affiliated with UMass Amherst. <a href="/about/">About</a> · <a href="/pricing/">Pricing</a> · <a href="/compare/">Compare</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
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


# ---- the page's own data as a chart (2026-10-05)
# The SEO audit (g_multimodal) found 115 of 297 pages with no image at all. Each listing page now carries
# one small bar chart drawn from its own open roles, with alt text that states the same numbers, so a
# reader (or a crawler, or a screen reader) gets them either way. It is an <img> of an SVG data URI:
# no extra files, nothing fetched, and the SVG's own media query follows the reader's dark mode.
CHART_BARS = 6


def chart_counts(items: list[dict], state: str | None) -> tuple[str, list[tuple[str, int]]]:
    """(what the bars are, [(label, roles)]) for a page's chart: by state where the page spans states
    (field, employer and hub pages), by employer where it is one place (state and field-in-state pages).
    A role filed in two states counts in each, as on the state pages themselves."""
    c: Counter = Counter()
    if state is None:
        for x in items:
            c.update("Remote" if k == "remote" else US_STATES[k] for k in x.get("keys") or () if k in PLACES or k == "remote")
        dim = "state"
    else:
        c.update(x["company_name"] for x in items if x.get("company_name"))
        dim = "employer"
    pairs = sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))
    return dim, pairs


def chart_figure(items: list[dict], state: str | None = None) -> str:
    """A bar chart of the page's open roles, or "" when there is nothing to compare (one group)."""
    dim, pairs = chart_counts(items, state)
    if len(pairs) < 2:
        return ""
    # The rest is said in words, not drawn: one "everything else" bar dwarfed the bars it summed.
    rows, rest = pairs[:CHART_BARS], sum(n for _, n in pairs[CHART_BARS:])
    others = len(pairs) - len(rows)
    top = max(n for _, n in rows)
    # Narrow, with large type: on a phone the image scales to ~335px wide and the labels must stay readable.
    w, label_w, bar_w, row_h = 520, 190, 270, 30
    h = row_h * len(rows) + 8
    bars = "".join(
        f'<text x="{label_w - 10}" y="{i * row_h + 22}" text-anchor="end" class="l">{esc(lbl[:22])}</text>'
        f'<rect x="{label_w}" y="{i * row_h + 6}" width="{max(2, round(bar_w * n / top))}" height="20" rx="3" class="b"/>'
        f'<text x="{label_w + max(2, round(bar_w * n / top)) + 8}" y="{i * row_h + 22}" class="n">{n:,}</text>'
        for i, (lbl, n) in enumerate(rows))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
           '<style>.l,.n{font:17px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#454a52}.n{fill:#17191c}'
           '.b{fill:#1d5c46}@media (prefers-color-scheme:dark){.l{fill:#b8b6af}.n{fill:#ecebe6}.b{fill:#7cc3a1}}</style>'
           + bars + "</svg>")
    total = len(items)
    what = "by state" if dim == "state" else "by employer"
    more = (f"; {rest:,} more in {plural(others, 'other state')}" if dim == "state"
            else f"; {rest:,} more at {plural(others, 'other employer')}") if others else ""
    alt = (f"Bar chart of the {total:,} open roles on this page {what}: "
           + ", ".join(f"{lbl} {n:,}" for lbl, n in rows) + more + ".")
    caption = ((f"Where these {total:,} roles are" if dim == "state" else f"Who is hiring these {total:,} roles")
               + ", counted from the open listings" + (" (a role in two states counts in each)" if dim == "state" else "")
               + (f". Not shown: {more[2:]}." if more else "."))
    # '#' must be encoded: unescaped it starts a fragment and cuts the image off at the first colour.
    src = "data:image/svg+xml;charset=utf-8," + quote(svg, safe=" =:/;,.-()'")
    return (f'<figure class="chart"><img src="{esc(src)}" alt="{esc(alt)}" width="{w}" height="{h}" loading="lazy"/>'
            f"<figcaption>{esc(caption)}</figcaption></figure>")


def listing_body(items: list[dict], what: str, where: str, now: datetime, related: str,
                 state: str | None = None, dash: str = "/", fits: list[str] | None = None,
                 here: str | None = None, tail: str = TAIL, about: frozenset = frozenset(), extra: str = "",
                 src: str = "seo-field") -> str:
    more = len(items) - PER_PAGE
    order = "newest" if state else "newest, Northeast and remote first,"
    # `extra`: the employer pages' "at a glance" list, under the opening paragraph (2026-10-01).
    # `src`: which kind of page this is, for the install links' ?from= and the store's utm_source
    # (2026-10-04; see autoapply_card).
    return (f"<p class=\"lede\">{summary(items, what, where, tail, about)}</p>" + fits_line(fits or []) + extra +
            f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
            + autoapply_card(items, src, state)
            + f"<ul class=\"jobs\">{listing_rows(items, now, state, here, src)}</ul>"
            + (f"<p class=\"more\">Showing the {PER_PAGE} {order} of {len(items):,}. "
               f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>" if more > 0 else "")
            # The page's own numbers as a chart, under the list it summarises (2026-10-05, g_multimodal).
            + chart_figure(items, state)
            + "<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
              "<a href=\"feed.xml\">RSS feed</a></p>"
            # The extension has been in the Chrome Web Store since 2026-09-22. This links the install
            # page rather than the store: it's ours, so the link stays inside the site, and it tells a
            # phone reader to send it to a laptop instead of dropping them on a store page that can't
            # install anything. ?from= becomes the store link's utm_source there (install.html's
            # canonical link keeps it one page to search engines). Since 2026-10-04 the tag says which
            # kind of page (src). was: ?from=landing-page on every page.
            + f"<p class=\"follow\">Applying to a few? The free <a href=\"/install.html?from={esc(src)}\">Auto-Apply extension</a> "
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


# Pay text whose numbers only look hourly (added 2026-10-02, found building /internships/highest-paying/):
# "$110k" and "$95K – $100K" are yearly salaries written in thousands, and Maven Securities' employer
# page said "$110 an hour"; "$75 to $100," ends in a comma, so the figure was cut off mid-number; and
# "$60.500" is $60,500 with a point for the comma.
_THOUSANDS = re.compile(r"\d\s*k\b", re.I)
_CUT_OFF = re.compile(r"\d,\s*$")
_POINT_THOUSANDS = re.compile(r"\d\.\d{3}\b")


def hourly_rate(x: dict) -> tuple[float, float] | None:
    """One posting's listed hourly rate as (low, high), or None when it gives no clear one. A bare
    amount counts as hourly only under $200 (student pay quoted without a unit is an hourly rate); a
    yearly salary, monthly or weekly pay or a stipend is left out rather than turned into a made-up
    hourly figure, and so is pay text that only looks hourly (_THOUSANDS, _CUT_OFF, _POINT_THOUSANDS)."""
    s = real_salary(x)
    if not s or any(r.search(s) for r in (_NOT_HOURLY, _THOUSANDS, _CUT_OFF, _POINT_THOUSANDS)):
        return None
    # was: if not s or _NOT_HOURLY.search(s): continue   (inside hourly_range's loop)
    nums = [float(a.replace(",", "")) for a in _AMOUNT.findall(s)]
    nums = [v for v in nums if 7 <= v < 200] if (_HOURLY.search(s) or all(v < 200 for v in nums)) else []
    return (min(nums), max(nums)) if nums else None


def hourly_range(items: list[dict]) -> tuple[float, float, int] | None:
    """Lowest and highest hourly rate the postings list, and how many list one (see hourly_rate)."""
    rates = [r for r in (hourly_rate(x) for x in items) if r]
    # was: the parsing now in hourly_rate, inline in a loop here.
    return (min(lo for lo, _ in rates), max(hi for _, hi in rates), len(rates)) if rates else None


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


# ---------------------------------------------------------------- for AI assistants and answer engines
# Added 2026-10-02. ChatGPT search, Claude, Perplexity, Gemini and Google's AI Overviews, and Copilot
# answer "is there a free internship search for my major?" from pages they can read and quote. These
# give them what a student asks first, each answer in the opening sentence of its section, and every
# number counted from the same export the listing pages are built from: /about/, /compare/,
# /internships/highest-paying/, and /llms.txt and /llms-full.txt (the llmstxt.org format). Nothing
# is shown only to crawlers: they are ordinary pages, linked from every footer and in the sitemap.
# The founder is never named here, as on the rest of the site; the brand speaks for itself.

ORG_ID, SITE_ID = SITE + "/#organization", SITE + "/#website"
ORGANIZATION = {"@context": "https://schema.org", "@type": "Organization", "@id": ORG_ID, "name": "InternScout",
                "url": SITE + "/", "logo": SITE + "/icon512.png", "slogan": SLOGAN,
                "description": "A free internship search for college students of every major in the US and Canada.",
                # The brand's own profile, which links back here (docs/index.html: rel="me").
                "sameAs": ["https://mastodon.social/@internscout"]}
WEBSITE = {"@context": "https://schema.org", "@type": "WebSite", "@id": SITE_ID, "name": "InternScout",
           "url": SITE + "/", "inLanguage": "en-US", "publisher": {"@id": ORG_ID}}

# The plans as worker/src/config.js prices them (PLANS: supporter, pro; repriced 2026-09-30).
PLAN_PRICES = (("Supporter", "$4"), ("Pro", "$8"))
# The free allowance in numbers, from FREE_EDU and FREE_GENERAL (2026-10-04). was: "a monthly allowance,
# doubled with a school .edu email", which is not exact (25 is not twice 12) and told a reader nothing.
FREE_WORDS = (f"{FREE_EDU['autofill']} Auto-Apply runs and {FREE_EDU['resume_tailor']} tailored resumes a month "
              f"with a school .edu email ({FREE_GENERAL['autofill']} and {FREE_GENERAL['resume_tailor']} otherwise)")

# Each plan's multiplier on the free allowance (worker/src/config.js PLANS), and what that comes to,
# worked out the way worker/src/limits.js allowanceFor does: a .edu account gets round(units x multiplier),
# anyone else floor(half of that), never below 1. So Supporter is 50 runs with a .edu email and 25 without.
# Added 2026-10-05 for /pricing/, which states every tier in numbers.
PLAN_MULTIPLIER = {"Free": 1, "Supporter": 2, "Pro": 4}
PLAN_SHORT = {"Free": "Enough to try it on real applications.",
              "Supporter": "Covers the AI bill for a month of steady applying.",
              "Pro": "For a full-time search: a hundred applications a month."}
RECOMMENDED_PLAN = "Supporter"


def plan_allowance(name: str) -> tuple[dict, dict]:
    """(.edu, other) monthly allowances of a plan, per task, as the Worker computes them."""
    m = PLAN_MULTIPLIER[name]
    edu = {k: round(v * m) for k, v in FREE_EDU.items()}
    other = {k: max(1, (v * m) // 2) for k, v in FREE_EDU.items()}
    return edu, other


def _offer(name: str, price: str) -> dict:
    """One schema.org Offer for a plan: price per month in USD, from PLAN_PRICES ("$4" -> "4")."""
    edu, other = plan_allowance(name)
    amount = price.lstrip("$") if price != "$0" else "0"
    offer = {"@type": "Offer", "name": name, "price": amount, "priceCurrency": "USD",
             "url": SITE + "/pricing/#" + name.lower(), "availability": "https://schema.org/InStock",
             "description": f"{edu['autofill']} Auto-Apply runs and {edu['resume_tailor']} tailored resumes a month with a "
                            f"school .edu email ({other['autofill']} and {other['resume_tailor']} otherwise)"}
    if amount != "0":
        offer["priceSpecification"] = {"@type": "UnitPriceSpecification", "price": amount, "priceCurrency": "USD",
                                       "billingIncrement": 1, "unitCode": "MON"}
    return offer


# The product and its three offers, for answer engines asked "how much does InternScout cost" (the audit
# of 2026-10-05: Organization and WebSite were there, no Product or Offer). On /pricing/ and, the same
# object, in docs/index.html; backend/tests/test_seo_pages.py checks the two agree.
PRODUCT = {"@context": "https://schema.org", "@type": "Product", "@id": SITE + "/#product",
           "name": "InternScout Auto-Apply",
           "description": "A free internship search for college students of every major, with a Chrome extension that "
                          "fills in applications from your resume and never submits them. Search needs no account; the "
                          "extension has a free monthly allowance, and two paid plans raise it.",
           "brand": {"@id": ORG_ID}, "url": SITE + "/pricing/", "image": SITE + "/icon512.png",
           "offers": [_offer("Free", "$0")] + [_offer(name, price) for name, price in PLAN_PRICES]}

# The applicant tracking systems a listing's "ats" names, as their makers write them. "other" (an
# employer's own careers site, or a public list) is left out of the count of roles taken straight
# from an employer's job board.
ATS_NAMES = {"workday": "Workday", "greenhouse": "Greenhouse", "oracle": "Oracle", "icims": "iCIMS",
             "icims_site": "iCIMS", "ashby": "Ashby", "lever": "Lever", "eightfold": "Eightfold",
             "taleo": "Taleo", "bamboohr": "BambooHR", "jazzhr": "JazzHR", "workable": "Workable",
             "successfactors": "SuccessFactors", "rippling": "Rippling", "smartrecruiters": "SmartRecruiters",
             "jobvite": "Jobvite", "recruitee": "Recruitee", "adp": "ADP", "paylocity": "Paylocity"}
# was: ... "jobvite": "Jobvite"}. The last three (2026-10-04) are in SUPPORTED_ATS, so autoapply_card
# can name them; no listing carries them yet, so no count on /about/ changes.


def pct(k: int, n: int) -> str:
    """k of n as a whole percent, rounded down like summary()'s "N% list pay"."""
    return f"{k * 100 // n}%" if n else "0%"


def site_facts(listings: list[dict]) -> dict:
    """What the whole export says about InternScout's coverage: the numbers /about/, /compare/ and
    llms.txt state, so they all agree with each other and with the listing pages."""
    fields = Counter(t for x in listings for t in set(x.get("field_tags") or []) - SKIP_FIELDS)
    boards = Counter(ATS_NAMES[x["ats"]] for x in listings if x.get("ats") in ATS_NAMES)
    keys = {k for x in listings for k in x["keys"]}
    canada = sum(1 for x in listings
                 if any(isinstance(g, dict) and g.get("kind") == "canada" for g in x.get("regions") or []))
    return {"open": len(listings),
            "employers": len({employer_key(x["company_name"]) for x in listings if x.get("company_name")}),
            "fields": fields, "boards": boards, "from_boards": sum(boards.values()), "canada": canada,
            # The 50 states only: DC and Puerto Rico are counted on their own pages, not here.
            "states": sorted(k for k in keys if k in PLACES and k not in CA_PROVINCES and k not in ("DC", "PR")),
            "provinces": sorted(k for k in keys if k in CA_PROVINCES),
            "paid": sum(1 for x in listings if is_paid(x)),
            "hourly": sum(1 for x in listings if hourly_rate(x))}


def coverage_line(f: dict) -> str:
    """ "14,366 open internships, co-ops and research roles from 1,702 employers in 65 fields" """
    return (f"{plural(f['open'], 'open internship, co-op and research role', 'open internships, co-ops and research roles')}"
            f" from {plural(f['employers'], 'employer')} in {plural(len(f['fields']), 'field')}")


def boards_line(f: dict) -> str:
    """Where the listings come from, counted: "86% of open roles come straight from employers' own
    applicant tracking systems (Workday, Greenhouse, Oracle, iCIMS, Ashby and Lever are the largest)"."""
    if not f["from_boards"]:
        return "every open role links to the posting on the employer's own site"
    return (f"{pct(f['from_boards'], f['open'])} of open roles come straight from employers' own applicant "
            f"tracking systems ({join_words(top(f['boards'], 6))} are the largest)")


def word_list(words: list[str]) -> str:
    """join_words with a comma before the last "and", for names that hold an "and" themselves:
    "finance, data science and analytics, and operations"."""
    return join_words(words) if len(words) < 3 else ", ".join(words[:-1]) + ", and " + words[-1]


def canada_only(x: dict) -> bool:
    """A role whose every location is in Canada, so its pay is most likely in Canadian dollars."""
    regions = [g for g in x.get("regions") or [] if isinstance(g, dict)]
    return bool(regions) and all(g.get("kind") == "canada" for g in regions)


# ---- /internships/highest-paying/

MIN_PAY_ROLES = 25      # open roles with a clear hourly rate before the page is made (as MIN_KIND)
MIN_PAY_FIELD = 10      # ...in one field before the field has a row in the by-field table
MIN_PAY_EMPLOYER = 3    # ...at one employer before it has a row in the employers table
PAY_TOP = 30            # roles in the top list
PAY_PER_EMPLOYER = 3    # at most this many of them from one employer, so one employer's many
                        # identical postings don't fill the list
PAY_EMPLOYERS = 25      # rows in the employers table
_GRADUATE = re.compile(r"\b(ph\.?\s?d|mba|master'?s?|graduate)\b", re.I)


def rate_words(lo: float, hi: float) -> str:
    return (money(lo) if lo == hi else f"{money(lo)}–{money(hi)}") + " an hour"


def pay_report(listings: list[dict], fields: dict[str, list]) -> dict:
    """The highest listed hourly pay among the open roles: the top roles, the median and top rate by
    field, and the employers that list the most. Only hourly_rate's clear hourly figures count; a
    yearly salary or stipend is left out, never converted. The same role on two of one employer's
    boards counts once (as dedupe_roles, but across every employer at once). Roles only in Canada are
    left out: their pay is in Canadian dollars, and a ranking in two currencies ranks neither."""
    seen, roles = set(), []
    for x in newest_first(listings):
        r = hourly_rate(x)
        if not r or canada_only(x):
            continue
        # The same title, place and rate is the same role, even under two spellings of the employer
        # ("Cadence" and "Cadence Design Systems" both posted Software Intern, San Jose, $31.63-$58.75).
        key = (re.sub(r"\W+", " ", (x.get("title") or "").lower()).strip(), place(x), r)
        if key not in seen:
            seen.add(key)
            roles.append((x, r[0], r[1]))
    mid = lambda lo, hi: (lo + hi) / 2              # noqa: E731  a range counts as its midpoint in a median
    # Ranked by the top of the range, then its bottom; ties go to the name, title and id, so every
    # build of the same data lists them in the same order.
    ranked = sorted(roles, key=lambda r: (-r[2], -r[1], str(r[0].get("company_name") or ""),
                                          str(r[0].get("title") or ""), r[0]["id"]))
    per: Counter = Counter()
    top_roles = []
    for r in ranked:
        k = employer_key(r[0].get("company_name") or "")
        if per[k] < PAY_PER_EMPLOYER and len(top_roles) < PAY_TOP:
            per[k] += 1
            top_roles.append(r)
    by_field = []
    for t in sorted(fields):
        rates = [(lo, hi) for x, lo, hi in roles if t in (x.get("field_tags") or [])]
        if len(rates) >= MIN_PAY_FIELD:
            by_field.append((t, len(rates), median(mid(lo, hi) for lo, hi in rates), max(hi for _, hi in rates)))
    by_field.sort(key=lambda r: (-r[2], -r[3], field_title(r[0])))
    groups: dict[str, list] = {}
    for x, lo, hi in roles:
        if x.get("company_name"):
            groups.setdefault(employer_key(x["company_name"]), []).append((x, lo, hi))
    by_employer = []
    for _, rs in sorted(groups.items()):
        if len(rs) < MIN_PAY_EMPLOYER:
            continue
        names = Counter(x["company_name"] for x, _, _ in rs)
        name = min(names, key=lambda n: (-names[n], len(n), n))        # the spelling build() picks
        by_employer.append((name, len(rs), median(mid(lo, hi) for _, lo, hi in rs),
                            min(lo for _, lo, _ in rs), max(hi for _, _, hi in rs)))
    by_employer.sort(key=lambda r: (-r[2], -r[4], r[0]))
    return {"roles": roles, "top": top_roles, "by_field": by_field, "by_employer": by_employer[:PAY_EMPLOYERS],
            "employers_listing": sum(1 for rs in groups.values() if len(rs) >= MIN_PAY_EMPLOYER),
            "median": median(mid(lo, hi) for _, lo, hi in roles) if roles else None,
            # Roles whose pay is given some other way: a yearly salary, monthly pay, a stipend.
            "other_pay": sum(1 for x in listings if real_salary(x) and not hourly_rate(x)),
            "canada": sum(1 for x in listings if hourly_rate(x) and canada_only(x))}


def pay_rows(top_roles: list[tuple], now: datetime) -> str:
    rows = []
    for x, lo, hi in top_roles:
        meta = [esc(place(x))] + ([esc(str(x["term"]))] if x.get("term") else [])
        new_tag = ' <span class="new">New</span>' if fresh(x, now, BASELINE) else ""
        rows.append(
            '<li class="job">'
            f'<div class="co">{company_link(x.get("company_name") or "")}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{" · ".join(meta)} · <span class="pay">{esc(rate_words(lo, hi))}</span></div>'
            f'<a class="go" href="{esc(safe_url(x["apply_url"]))}" rel="nofollow noopener" target="_blank">Open posting</a>'
            "</li>")
    return "\n".join(rows)


def table(head: list[str], rows: list[list[str]], num_from: int = 1, cls: str = "data") -> str:
    """An HTML table; cells are HTML already. Columns from num_from on hold figures and don't wrap."""
    th = "".join(f"<th scope=\"col\">{h}</th>" for h in head)
    body = "".join("<tr>" + "".join(f"<td class=\"num\">{c}</td>" if i >= num_from else
                                    (f"<th scope=\"row\">{c}</th>" if i == 0 else f"<td>{c}</td>")
                                    for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f"<div class=\"tablewrap\"><table class=\"{cls}\"><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>"


def pay_page(rep: dict, f: dict, now: datetime, fields: dict[str, list], paid_page: bool) -> tuple[str, str, str]:
    """(title, description, body) of /internships/highest-paying/."""
    x0, _, hi0 = rep["top"][0]
    n, k = f["open"], f["hourly"]
    grad = sum(1 for x, _, _ in rep["top"] if _GRADUATE.search(x.get("title") or ""))
    lede = (f"The highest hourly pay listed on an open internship, co-op or research role is "
            f"{esc(money(hi0))} an hour, at {company_link(x0.get('company_name') or '')} "
            f"({esc(x0.get('title') or '')}). Across the {len(rep['roles']):,} open roles that list a clear "
            f"hourly rate, the median is {esc(money(round(rep['median'], 2)))} an hour.")
    body = [f"<p class=\"lede\">{lede}</p>",
            f"<a class=\"cta\" href=\"{dash_link(paid=True)}\">See every paid role on the dashboard</a>",
            "<section class=\"prose\"><h2>Top internships by listed hourly pay</h2>",
            f"<p class=\"more\">The {len(rep['top'])} open roles with the highest listed rate, at most "
            f"{PAY_PER_EMPLOYER} from one employer."
            + (f" {grad} of them {'is' if grad == 1 else 'are'} for graduate students (the title says PhD, "
               "MBA, master’s or graduate)." if grad else "") + "</p>",
            f"<ul class=\"jobs\">{pay_rows(rep['top'], now)}</ul></section>"]
    if rep["by_field"]:
        rows = [[f"<a href=\"/internships/{field_slug(t)}/\">{esc(field_title(t))}</a>",
                 f"{c:,} of {len(fields[t]):,}", esc(money(round(m, 2))), esc(money(h))]
                for t, c, m, h in rep["by_field"]]
        body.append("<section class=\"prose\"><h2>Listed pay by field</h2>"
                    f"<p>The {len(rep['by_field'])} fields where at least {MIN_PAY_FIELD} open roles list an "
                    "hourly rate, by median rate. The count is of roles that list a rate, out of the field’s "
                    "open roles; most postings in every field give no rate.</p>"
                    + table(["Field", "Roles listing a rate", "Median", "Highest"], rows) + "</section>")
    if rep["by_employer"]:
        rows = [[company_link(nm), f"{c:,}", esc(money(round(m, 2))), esc(rate_words(lo, hi).replace(" an hour", ""))]
                for nm, c, m, lo, hi in rep["by_employer"]]
        body.append("<section class=\"prose\"><h2>Top-paying employers</h2>"
                    f"<p>Employers with at least {MIN_PAY_EMPLOYER} open roles that list an hourly rate, by "
                    f"median rate: the top {len(rows)} of {rep['employers_listing']:,}.</p>"
                    + table(["Employer", "Roles listing a rate", "Median", "Range"], rows) + "</section>")
    body.append(
        "<section class=\"prose\"><h2>How this is counted</h2>"
        f"<p>{f['paid']:,} of the {n:,} open roles ({pct(f['paid'], n)}) list pay or say they are paid, and "
        f"{k:,} ({pct(k, n)}) give a clear hourly rate. A rate counts when the posting gives it per hour, or "
        "as amounts under $200 with no unit, which is how student pay is usually written. Yearly salaries, "
        "monthly or weekly pay and stipends are left out, never converted to an hourly figure "
        f"(that leaves out {plural(rep['other_pay'], 'role')}), and so are amounts written in thousands "
        "(“$100k”), placeholder figures such as “$0.00”, and pay text that is cut off. A range counts as "
        "its midpoint in the medians, and roles are ranked by the top of their range. "
        + (f"Roles only in Canada ({rep['canada']:,} with a rate) are left out of this page, since their pay "
           "is in Canadian dollars. " if rep["canada"] else "")
        + "The same role "
        "posted on two of an employer’s boards counts once. Every figure is what the employer’s posting "
        "says; check the posting before you rely on it.</p>"
        + ("<p>Every role that lists pay or says it is paid, hourly or not: "
           "<a href=\"/internships/paid/\">paid internships</a>.</p>" if paid_page else "")
        + "</section>")
    title = f"Highest-Paying Internships – Up to {money(hi0)} an Hour Listed | InternScout"
    desc = (f"The highest hourly pay listed on {len(rep['roles']):,} open internships, co-ops and research roles: "
            f"top roles, median pay by field and top-paying employers. Updated {long_day(now.isoformat())}.")
    return title, desc, "".join(body)


# ---- /about/

def about_answers(f: dict, majors: int, new: int, rep: dict | None) -> list[tuple[str, str, str]]:
    """(question, answer, extra HTML) for /about/. The answer is plain text, the same words in the page
    and in its FAQPage block; the extra (a link) is the page's only."""
    top_fields = [lower_name(field_title(t)) for t in top(f["fields"], 5)]
    plans = " and ".join(f"{name} ({price} a month)" for name, price in PLAN_PRICES)
    qa = [
        ("What is InternScout?",
         f"InternScout is a free internship search for college students of every major in the US and "
         f"Canada. It lists {coverage_line(f)}, collected from employers’ own job boards several times a "
         f"day. {SLOGAN}", ""),
        ("Is InternScout free?",
         "Yes. Searching, ranking and browsing every listing are free and need no account. The optional "
         f"Auto-Apply Chrome extension is free for {FREE_WORDS}; optional {plans} plans raise the allowance.",
         " <a href=\"/pricing/\">Plans and prices</a>."),
        # was: "... is free with a monthly allowance, which a school .edu email doubles; ..."
        ("Which majors is InternScout for?",
         f"Every major. Open roles are sorted into {len(f['fields'])} fields; the largest right now are "
         f"{word_list(top_fields)}, and there are pages for {majors} majors.",
         " <a href=\"/internships/for/\">Internships by major</a>."),
        ("Where do the listings come from?",
         f"From employers’ public job boards: {boards_line(f)}. InternScout respects each site’s robots.txt, "
         "and every listing links to the posting on the employer’s own site.", ""),
        ("How often is InternScout updated?",
         f"Several times a day. Each run looks for new roles and drops ones that have closed; "
         f"{plural(new, 'role was', 'roles were')} found in the last week.",
         " <a href=\"/internships/new/\">New this week</a>." if new >= MIN_OPEN else ""),
        ("Does Auto-Apply submit applications for me?",
         "No. The Auto-Apply extension fills in the application with AI and stops at the submit button. "
         "You review every answer and press Submit yourself.",
         " <a href=\"/install.html?from=about\">Install guide</a>."),
        ("Is InternScout affiliated with UMass Amherst?",
         "No. InternScout was built by a UMass Amherst student, but it is not affiliated with or endorsed "
         "by UMass Amherst, or by any employer it lists.", ""),
        ("How is InternScout different from Simplify or Jobright?",
         "InternScout is only for students looking for internships, co-ops and research, its search is "
         f"free with no account, its paid plans are {' or '.join(p for _, p in PLAN_PRICES)} a month, and its "
         "extension never submits. Simplify and Jobright cover job seekers at every level; Simplify+ is "
         f"$39.99 a month, and Jobscan reported Jobright’s Turbo plan at $39.99 a month (as of {COMPARE_AS_OF}).",
         # was: "... paid plans are $4 or $8 a month ... (as of October 1, 2026)." written out, so a
         # repricing or a refreshed comparison would have left this answer behind (2026-10-02 review).
         " <a href=\"/compare/\">The full comparison, with sources</a>."),
    ]
    if rep:
        qa.append(("How much do internships on InternScout pay?",
                   f"{pct(f['hourly'], f['open'])} of open roles list a clear hourly rate. Leaving out roles "
                   f"only in Canada, paid in Canadian dollars, the median is {money(round(rep['median'], 2))} "
                   f"an hour and the highest is {money(rep['top'][0][2])} an hour.",
                   # was: "... list a clear hourly rate. Among those, the median is ...": the median and
                   # top are pay_report's, which leaves out roles only in Canada (2026-10-02 review).
                   " <a href=\"/internships/highest-paying/\">Highest-paying internships</a>."))
    # In the first person since 2026-10-05 (the audit asked for the "why I built this" behind the slogan).
    # Still no name: the site speaks as the brand, as the module comment above says.
    # was: f"One college student builds and runs it, for students everywhere. {SLOGAN}"
    qa.append(("Who makes InternScout?",
               "One college student builds and runs it, for students everywhere. I started it during my own "
               "internship search, when every morning meant checking ten different job boards, most of what they "
               "showed was stale or not for students, and everything I had applied to lived in a messy "
               "spreadsheet. So I wrote a scanner that reads employers' own job boards several times a day and "
               "keeps only the student roles, and put a free search in front of it that needs no account. The "
               "Auto-Apply extension came later, for the hours that go into typing the same resume into the same "
               "form on Workday and Greenhouse. It never submits for you: it is your application, and you press "
               f"Submit. {SLOGAN}", ""))
    return qa


def about_page(f: dict, qa: list[tuple[str, str, str]], updated: str) -> tuple[str, str, str, list]:
    """(title, description, body, JSON-LD) of /about/."""
    faq = {"@context": "https://schema.org", "@type": "FAQPage",
           "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                          for q, a, _ in qa]}
    body = (f"<p class=\"lede\">InternScout is a free internship search for college students of every major "
            f"in the US and Canada: {esc(coverage_line(f))}, as of {esc(updated)}.</p>"
            "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
            "<section class=\"faq\">" + "".join(f"<h2>{esc(q)}</h2><p>{esc(a)}{extra}</p>" for q, a, extra in qa)
            + "</section>"
            "<p class=\"more\">A plain-text summary for AI assistants: <a href=\"/llms.txt\">llms.txt</a> "
            "(and the longer <a href=\"/llms-full.txt\">llms-full.txt</a>).</p>")
    return ("About InternScout – Free Internship Search for Every Major | InternScout",
            f"InternScout is a free internship search for college students of every major: {coverage_line(f)}. "
            "No account needed.", body, [ORGANIZATION, WEBSITE, faq])


# ---- /compare/
# Competitor facts only with a source and a date, printed on the page (the same ones as the comparison
# card, growth/comparison.py). To refresh: check both sources, then COMPARE_AS_OF and the rows.
COMPARE_AS_OF = "October 1, 2026"
COMPARE_SOURCES = [
    ("Simplify", "https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing",
     "Simplify Help Center, article on Simplify’s features and pricing, checked October 1, 2026"),
    ("Jobright", "https://jobscan.co/blog/jobscan-vs-jobright",
     "Jobscan blog, Jobscan vs Jobright, July 2026 (Jobright publishes no student pricing)"),
]
COMPARE_ROWS = [
    ("Made for", "College students of every major: internships, co-ops and research, US and Canada",
     "Job seekers at every level", "Job seekers at every level"),
    # was: "...; the Auto-Apply extension up to a monthly allowance (doubled with a school .edu email)"
    ("Free", f"Search and browsing, with no account; {FREE_WORDS}",
     "Autofill extension (Copilot), job tracker and resume builder", "A free tier that runs on daily credits"),
    # Jobright's 3-month price and its Resume AI are from the same Jobscan article, re-read 2026-10-04:
    # Turbo quarterly $89.99 (about $30 a month), and Resume AI tailors a resume in about a minute; it
    # does not say which plan includes Resume AI, so neither does this.
    # was: "Turbo $39.99/month ($17.99/week), as reported by Jobscan" and "Not covered by the source below"
    ("Paid plan", "Optional: Supporter $4/month, Pro $8/month",
     "Simplify+ $39.99/month ($19.99/week, $89.99 for 3 months)",
     "Turbo $39.99/month ($17.99/week, $89.99 for 3 months), as reported by Jobscan"),
    ("AI resume tailoring", "In the extension, within the monthly allowance",
     "Simplify+ (with AI cover letters)", "Resume AI, about a minute a resume (plan not stated by the source)"),
    ("Who submits the application", "Always you: Auto-Apply fills the form and never submits", "You",
     "You, or its AI Agent (supervised or fully automatic)"),
]


def compare_page(f: dict) -> tuple[str, str, str]:
    """(title, description, body) of /compare/."""
    rows = [[esc(label)] + [esc(c) for c in cells] for label, *cells in COMPARE_ROWS]
    # "every major" shown, not only said: fields far from engineering that have open roles today.
    wide = [lower_name(field_title(t)) for t in ("nursing", "health", "social_work", "education", "arts", "journalism")
            if f["fields"].get(t, 0) >= MIN_OPEN][:3]
    breadth = f", from engineering and finance to {esc(word_list(wide))}" if wide else ""
    sources = "".join(f"<li>{esc(name)}: <a href=\"{esc(url)}\" rel=\"noopener\">{esc(what)}</a></li>"
                      for name, url, what in COMPARE_SOURCES)
    body = (
        "<p class=\"lede\">InternScout, Simplify and Jobright all help you find jobs and fill in applications. "
        "They differ in who they are for, what they cost, and who presses Submit. Simplify and Jobright cover "
        "every career level; InternScout lists only internships, co-ops and research roles for college "
        f"students: {f['open']:,} open today, from {plural(f['employers'], 'employer')} in "
        f"{plural(len(f['fields']), 'field')}.</p>"
        + table(["", "InternScout", "Simplify", "Jobright"], rows, num_from=99, cls="data cmp")
        + f"<p class=\"src\">Competitor facts as of {COMPARE_AS_OF}, from the sources below. Prices change; "
          "check each company’s site before you pay.</p>"
        "<section class=\"prose\"><h2>Who each one is for</h2>"
        "<p>Simplify and Jobright are built for job seekers at every level, so they are the better fit if you "
        "also want full-time or experienced roles. InternScout is built only for college students looking for "
        f"internships, co-ops and research positions, in every major{breadth}.</p>"
        "<h2>What each one costs</h2>"
        "<p>Simplify’s autofill extension (Copilot), job tracker and resume builder are free; Simplify+ is "
        "$39.99 a month, $19.99 a week or $89.99 for three months, and adds AI resume tailoring and cover "
        "letters. Jobright publishes no student pricing; Jobscan reported its Turbo plan at $39.99 a month "
        "($17.99 a week or $89.99 for three months), and its free tier runs on daily credits. InternScout’s "
        f"search is free with no account, its Auto-Apply extension is free for {FREE_WORDS}, and its "
        "optional Supporter and Pro plans are $4 and $8 a month.</p>"
        # was: "... ($17.99 a week), ... is free up to a monthly allowance (doubled with a school .edu email), ..."
        "<h2>Who presses Submit</h2>"
        "<p>With Simplify’s extension, you submit each application yourself. Jobright’s AI Agent can submit "
        "applications for you, supervised or fully automatically. InternScout’s Auto-Apply fills in the form "
        "and stops: you review every answer and press Submit, every time.</p>"
        f"<h2>Sources</h2><ul>{sources}</ul>"
        "<p class=\"src\">Not affiliated with Simplify or Jobright. Names are used only to compare.</p></section>"
        "<a class=\"cta\" href=\"/\">Try InternScout’s search, free</a>")
    return ("InternScout vs Simplify vs Jobright – Price and Features Compared | InternScout",
            "InternScout, Simplify and Jobright compared: who each is for, free tiers, paid plans ($4–$8 vs "
            f"$39.99 a month) and who submits applications. Sources dated {COMPARE_AS_OF}.", body)


# ---- /pricing/
# Added 2026-10-05 after the site audit: the prices lived only in the dashboard's dismissible plans notice
# and the /about/ FAQ, with no page of their own, no link in the nav, no tier picked out, and the
# $4-against-$39.99 comparison far from any price. Every number here comes from the same constants as
# /about/ and /compare/ (FREE_EDU, PLAN_PRICES, PLAN_MULTIPLIER), which mirror worker/src/config.js.

def tier_card(name: str, price: str) -> str:
    """One plan as a card: name, price, what it is for, what it gives, and where to get it."""
    edu, other = plan_allowance(name)
    pick = name == RECOMMENDED_PLAN
    lines = [f"{edu['autofill']} Auto-Apply runs and {edu['resume_tailor']} tailored resumes a month with a school .edu email",
             f"{other['autofill']} runs and {other['resume_tailor']} resumes with any other email"]
    if name == "Free":
        lines = ["Search, ranking and browsing every listing, with no account"] + lines
        cta = "<a class=\"cta\" href=\"/\">Search free</a>"
    else:
        lines = ["Everything in Free"] + lines + ["Cancel any time; the plan runs to the end of the month you paid for"]
        # The dashboard reads ?upgrade= and offers that plan's checkout (docs/js/app.js), after sign-in.
        cta = f"<a class=\"cta\" href=\"/?upgrade={name.lower()}\">Get {esc(name)}</a>"
    return (f"<section class=\"tier{' pick' if pick else ''}\" id=\"{name.lower()}\">"
            + ("<span class=\"badge\">Most popular</span>" if pick else "")
            + f"<h2>{esc(name)}</h2>"
            + f"<p class=\"price\">{esc(price)}<span>{' a month' if price != '$0' else ''}</span></p>"
            + f"<p class=\"blurb\">{esc(PLAN_SHORT[name])}</p>"
            + "<ul>" + "".join(f"<li>{esc(line)}</li>" for line in lines) + "</ul>" + cta + "</section>")


def pricing_page() -> tuple[str, str, str, list]:
    """(title, description, body, JSON-LD) of /pricing/."""
    cards = "".join(tier_card(name, price) for name, price in (("Free", "$0"), *PLAN_PRICES))
    low = PLAN_PRICES[0][1]
    body = (
        "<p class=\"lede\">Search is free, with no account. The Auto-Apply extension has a free monthly allowance, "
        "and two plans raise it. Every price is per month, and you can cancel any time.</p>"
        f"<div class=\"tiers\">{cards}</div>"
        # The anchor next to the price, in the audit's words. The competitor figures are /compare/'s, with
        # their sources and date there.
        f"<p class=\"anchor\">Simplify+ and Jobright Turbo run $39.99 a month. This is {esc(low)}, for students only. "
        f"<a href=\"/compare/\">The full comparison, with sources</a> (prices as of {esc(COMPARE_AS_OF)}).</p>"
        "<section class=\"prose\">"
        "<h2>Before you pay</h2><ul class=\"plain\">"
        "<li><strong>No refunds by default.</strong> The AI cost is spent when a run happens. Start on the free "
        "tier, and pay only if you hit the cap.</li>"
        "<li><strong>The extension never submits.</strong> It fills in the form and stops at the Submit button; "
        "you review every answer before it sends.</li>"
        "<li><strong>Cancel any time.</strong> Stripe takes the payment and runs the billing page (Manage plan on "
        "the dashboard); InternScout never sees your card.</li></ul>"
        "<h2>What a run is</h2>"
        "<p>One Auto-Apply run is one application filled in. One tailored resume is one resume rewritten for one "
        "posting. The allowance resets on the 1st of each month. The Deep Dive, the profile interview you do "
        "once, has no monthly cap of its own.</p>"
        "<h2>What a school email changes</h2>"
        f"<p>A verified .edu email, from Google or Microsoft, about doubles what any plan gives: {esc(FREE_WORDS)} "
        "on the free tier, and the same again for Supporter and Pro. Any other email still gets every plan, at "
        "the lower numbers above.</p>"
        "<h2>Who it is for</h2>"
        "<p>College students looking for internships, co-ops and research roles, in every major. It is not for "
        "experienced job seekers: if you want full-time or senior roles, Simplify and Jobright cover every level, "
        "and <a href=\"/compare/\">the comparison</a> says what each costs.</p></section>")
    plans = " and ".join(f"{name} {price}" for name, price in PLAN_PRICES)
    # The description is under 155 characters, so a search result shows the $39.99 anchor too.
    return ("InternScout Pricing – Free Search, Auto-Apply Plans from " + low + " a Month | InternScout",
            f"Free to search, no account. The Auto-Apply extension has a free monthly allowance; {plans} a month "
            "raise it. Simplify+ and Jobright Turbo are $39.99.",
            body, [ORGANIZATION, PRODUCT])


# ---- /llms.txt and /llms-full.txt

def llms_files(f: dict, made: dict[str, tuple[str, int]], rep: dict | None, majors: int, employers: int,
               new: int, updated: str) -> dict[str, str]:
    """The two llmstxt.org files: llms.txt, an H1, a one-paragraph summary and lists of links to the
    pages that matter; llms-full.txt, the longer description an assistant can quote from. made is
    every page this build wrote (path -> (heading, open roles)), so neither links a page that isn't
    there. Dated from the data, like everything else a build writes."""
    def link(path: str, label: str | None = None, note: str = "") -> str:
        return f"- [{label or made[path][0]}]({SITE}{path})" + (f": {note}" if note else "")

    field_pages = [(t, n) for t, n in sorted(f["fields"].items(), key=lambda kv: (-kv[1], kv[0]))
                   if f"/internships/{field_slug(t)}/" in made]
    state_pages = sorted(((p, h, n) for p, (h, n) in made.items()
                          if p.count("/") == 3 and p.startswith("/internships/") and h.startswith("Internships in ")),
                         key=lambda e: (-e[2], e[0]))
    browse = [p for p in ("/internships/new/", "/internships/paid/", "/internships/co-op/", "/internships/research/",
                          "/internships/for-freshmen/", "/internships/for-sophomores/") if p in made]
    plans = ", ".join(f"{name} {price}/month" for name, price in PLAN_PRICES)
    summary_ = (f"InternScout ({SITE}) is a free internship search for college students of every major in the "
                f"US and Canada. As of {updated} it lists {coverage_line(f)}, collected several times a day from "
                f"employers' own job boards. Search is free and needs no account. {SLOGAN}")
    facts = [
        "Key facts:",
        "",
        "- Free: searching, ranking and browsing every listing; no account needed.",
        "- Optional Chrome extension, InternScout Auto-Apply: fills in applications with AI and never submits "
        f"them (the student reviews and submits). Free for {FREE_WORDS}. "
        f"Optional paid plans: {plans}.",
        # was: "... Free with a monthly allowance; a school .edu email doubles it. ..." (2026-10-04)
        f"- Coverage: {f['open']:,} open roles from {f['employers']:,} employers, in {len(f['fields'])} fields, "
        f"{len(f['states'])} of the 50 US states and {len(f['provinces'])} Canadian provinces and territories. "
        f"{boards_line(f)[0].upper()}{boards_line(f)[1:]}.",
        "- Updated several times a day. Every listing links to the employer's own posting.",
        "- Not affiliated with UMass Amherst, or with any employer it lists.",
    ]
    main_pages = [link("/", "Dashboard", "search every open listing and rank it for your major, class year and states"),
                  link("/about/", "About InternScout", "what it is, what is free, where listings come from, in direct answers"),
                  link("/pricing/", "Plans and prices", f"free search; the Auto-Apply extension's free allowance and the {plans} plans"),
                  link("/compare/", "InternScout vs Simplify vs Jobright", "prices and features compared, with dated sources")]
    if "/internships/highest-paying/" in made:
        main_pages.append(link("/internships/highest-paying/", "Highest-paying internships",
                               "top listed hourly pay by role, field and employer, rebuilt every update"))
    main_pages.append(link("/install.html", "Auto-Apply extension install guide",
                           "the free Chrome extension that fills applications and never submits"))
    lines = ["# InternScout", "", f"> {summary_}", "", *facts, "",
             "## Main pages", "", *main_pages, "",
             "## Browse internships", "",
             link("/internships/", "All internships by field, state, employer and major", f"{f['open']:,} open roles"),
             link("/internships/at/", "Internships by employer", f"{employers:,} employers with their own page"),
             link("/internships/for/", "Internships by major", f"{majors} majors"),
             *[link(p, note=f"{made[p][1]:,} open") for p in browse],
             *[link(f"/internships/{field_slug(t)}/", note=f"{made[f'/internships/{field_slug(t)}/'][1]:,} open")
               for t, _ in field_pages[:12]],
             *[link(p, note=f"{n:,} open") for p, _, n in state_pages[:8]],
             "",
             "## Feeds", "",
             *([link("/internships/new/feed.xml", "New internships this week (RSS)")] if "/internships/new/" in made else []),
             "- Every field, state, major and employer page has an RSS feed of its newest roles at its own "
             "address plus feed.xml"
             + (f", for example {SITE}/internships/{field_slug(field_pages[0][0])}/feed.xml" if field_pages else ""),
             "",
             "## Policies", "",
             link("/privacy", "Privacy policy"), link("/terms", "Terms of use"),
             "",
             "## Optional", "",
             link("/llms-full.txt", "Full description", "coverage, top fields and employers, pay, how it works, limits"),
             ""]
    short = "\n".join(lines)

    top_emp = sorted(((p, h, n) for p, (h, n) in made.items()
                      if p.startswith("/internships/at/") and p != "/internships/at/"), key=lambda e: (-e[2], e[0]))
    full = ["# InternScout", "", f"> {summary_}", "",
            f"Data as of {updated}. Every number below is counted from the listings open on that day.", "",
            "## What InternScout is", "",
            "InternScout is a website (internscout.org) for finding internships, co-ops, research positions and "
            "fellowships. It collects open roles from employers' public job boards, sorts them by field, location, "
            "start term and class year, and ranks them for the major, class year and states a student picks. "
            "Each listing links to the application on the employer's own site; InternScout takes no applications "
            "and charges employers nothing.", "",
            "## Who it is for", "",
            f"College students of every major, in the US and Canada. Open roles are sorted into {len(f['fields'])} "
            f"fields (all of them are listed below); the largest are "
            f"{word_list([lower_name(field_title(t)) for t in top(f['fields'], 5)])}. There are browse pages for "
            f"{majors} majors.", "",
            "## How it works", "",
            f"- Listings come from employers' public job boards: {boards_line(f)}. Each site's robots.txt is respected.",
            "- Several times a day the listings are refreshed: new roles are added and closed ones removed.",
            "- The dashboard (https://internscout.org/) filters by field, state, start term, class year, paid "
            "roles and new roles, and ranks the rest for the student's profile. No account is needed.",
            "- Every field, state, employer and major with enough open roles has a plain page under "
            "https://internscout.org/internships/ with its newest open roles and an RSS feed.", "",
            # was: "- Every field, state, employer and major has a plain page ...": only employers with
            # MIN_OPEN open roles do (702 of 1,725 on 2026-10-02), so the claim was not true (review).
            "## What is free and what is paid", "",
            "- Free: search, ranking, the browse pages, the RSS feeds. No account.",
            "- Free with a monthly allowance: the InternScout Auto-Apply Chrome extension, which fills in "
            "applications with AI and never submits them; the student reviews every answer and presses Submit. "
            f"The allowance is {FREE_WORDS}.",
            # was: "A school .edu email doubles the allowance." (2026-10-04)
            f"- Optional paid plans raise the allowance: {plans}.", "",
            "## Coverage", "",
            f"- Open roles: {f['open']:,}",
            f"- Employers: {f['employers']:,} ({employers:,} with their own page)",
            f"- Fields: {len(f['fields'])}",
            f"- Places: {len(f['states'])} of the 50 US states, and {len(f['provinces'])} Canadian provinces and "
            f"territories ({f['canada']:,} roles in Canada)",
            f"- Found in the last week: {new:,}",
            f"- List pay or say they are paid: {f['paid']:,} ({pct(f['paid'], f['open'])}); a clear hourly rate: "
            f"{f['hourly']:,} ({pct(f['hourly'], f['open'])})", "",
            # Every field, largest first, so "does it have nursing internships?" has an answer here; a
            # field with a page of its own is a link.
            "## Fields, by open roles", "",
            *[link(f"/internships/{field_slug(t)}/", field_title(t), f"{n:,} open")
              if f"/internships/{field_slug(t)}/" in made else f"- {field_title(t)}: {n:,} open"
              for t, n in sorted(f["fields"].items(), key=lambda kv: (-kv[1], kv[0]))], "",
            "## Employers with the most open roles", "",
            *[link(p, h.replace("Internships at ", ""), f"{n:,} open") for p, h, n in top_emp[:15]], ""]
    if rep:
        x0, _, hi0 = rep["top"][0]
        full += ["## Pay", "",
                 f"Among the {len(rep['roles']):,} open roles that list a clear hourly rate, the median is "
                 f"{money(round(rep['median'], 2))} an hour; the highest is {money(hi0)} an hour "
                 f"({x0.get('company_name') or ''}, {x0.get('title') or ''}). Yearly salaries and stipends are "
                 "left out, never converted, and so are roles only in Canada (paid in Canadian dollars); the "
                 "same role posted twice counts once. "
                 # was: "... left out, never converted. ": without the rest, this count (pay_report's)
                 # and the Coverage section's "a clear hourly rate" count read as two answers to one
                 # question (1,732 and 1,775 on 2026-10-02; review).
                 + (f"Highest median by field: {join_words([f'{field_title(t)} ({money(round(m, 2))})' for t, _, m, _ in rep['by_field'][:3]])}. "
                    if rep["by_field"] else "")
                 + f"Details: {SITE}/internships/highest-paying/", ""]
    full += ["## How to use it", "",
             "1. Open https://internscout.org/ and pick your major, class year and the states you want (or remote).",
             "2. Filter by start term, paid roles or new this week, and open the postings that fit.",
             "3. Apply on the employer's own site. The optional Auto-Apply extension can fill in the form; you "
             "review it and submit.",
             "4. To follow a field or a state, subscribe to its page's RSS feed in a feed reader, Discord or Slack.", "",
             "## Compared with Simplify and Jobright", "",
             f"As of {COMPARE_AS_OF}: Simplify+ is $39.99/month ($19.99/week, $89.99 for 3 months); its autofill "
             "extension (Copilot), tracker and resume builder are free, AI resume tailoring and cover letters are "
             "Simplify+, and the user submits (source: help.simplify.jobs/articles/5623502-whats-included-in-simplify-"
             "features-and-pricing). Jobright publishes no student pricing; Jobscan reported Turbo at $39.99/month "
             "($17.99/week), its free tier uses daily credits, and its AI Agent can submit applications, supervised "
             "or fully automatically (source: jobscan.co/blog/jobscan-vs-jobright, July 2026). Both cover every job "
             "level. InternScout: free search, a free extension allowance, $4 and $8 plans, never submits, every "
             f"major. Details: {SITE}/compare/", "",
             "## Limits", "",
             "- Only roles posted on public job boards InternScout scans are listed; a site whose robots.txt says "
             "no is not scanned, so some employers are missing.",
             "- Most postings do not give pay, a start term or the class years they take; pages say so rather than guess.",
             "- Listings can close between updates. Always check the posting on the employer's site before applying.",
             "- InternScout does not apply for anyone, and its extension never submits an application.", "",
             "## Disclaimer", "",
             "InternScout is a free internship search built by a UMass Amherst student. Not affiliated with UMass "
             "Amherst, or with any employer it lists. Not affiliated with Simplify or Jobright.", "",
             SLOGAN, ""]
    return {"llms.txt": short, "llms-full.txt": "\n".join(full)}


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

    def add(path, title, desc, h1, crumbs, body, items=None, state=None, ld=()):
        # lastmod is the day the page's newest listing was found: it moves when the page gains a
        # listing, not on every deploy, which is the only lastmod a search engine keeps trusting.
        found = [str(x.get("first_seen") or "")[:10] for x in (listings if items is None else items)]
        # The live sitemap's lastmod is a floor: when the newest role on a page closes, the newest left
        # is older, and a lastmod that goes backwards is one a search engine stops trusting.
        found.append(live.get(path) or "" if isinstance(live, dict) else "")
        pages.append({"path": path, "html": page(path, title, desc, h1, crumbs, body, updated, feed=items is not None, ld=ld),
                      "items": items, "h1": h1, "state": state,
                      "lastmod": max((f for f in found if f), default=None)})

    # Each listing page's src (2026-10-04, see autoapply_card): seo-field for a field and a field in a
    # state, seo-state for a state, province or city, seo-employer, and seo-hub for the rest.
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
            listing_body(items, f"in {lower_name(name)}", "", now, related, dash=dash_link([t]), fits=fits.get(path),
                         src="seo-field"), items)

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
            listing_body(items, "", f" {loc}", now, related, state=k, dash=dash_link(state=k),
                         src="seo-state"), items, k)

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
            listing_body(items, f"in {lower_name(name)}", f" {loc}", now, related, state=k, dash=dash_link([t], k),
                         src="seo-field"), items, k)

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
                         fits=[n for n in fits[path] if n != name], src="seo-hub"), items)

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
                         dash=dash_link(state=where, companies=spellings[name]), here=path, extra=facts,
                         src="seo-employer"), items)

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
                         tail=k.get("tail", TAIL), about=k.get("about", frozenset()), src="seo-hub"), items)

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
                         dash=dash_link(new=True), src="seo-hub"), new)
        # More than the usual newest 25, since this one feed may be a club's only one, but not every
        # new role: that was 1,800 items and 800 KB, fetched every few hours by every subscriber.
        pages[-1]["feed_limit"] = NEW_FEED        # was: None (every new role)

    # The highest listed hourly pay (2026-10-02), made before the hubs so the hub can link it. Kept
    # like any other page once live (enough), since its URL is the one a search result points at.
    facts = site_facts(listings)
    pay_path = "/internships/highest-paying/"
    rep = pay_report(listings, fields)
    if enough(len(rep["roles"]), pay_path, MIN_PAY_ROLES) and rep["top"]:
        t_, d_, b_ = pay_page(rep, facts, now, fields, any(p == "/internships/paid/" for p, _, _ in kind_made))
        add(pay_path, t_, d_, "Highest-paying internships", [root, (pay_path, "Highest-paying")], b_)
    else:
        rep = None

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
           + (f"<li><a href=\"{pay_path}\">Highest-paying internships</a> <span class=\"n\">{len(rep['roles']):,}</span></li>"
              if rep else "")
           + "</ul></section>")
    add("/internships/", f"Browse {len(listings):,} Open Internships by Field, State and Major | InternScout",
        f"{len(listings):,} open internships, co-ops and research roles for college students, updated "
        f"{updated}. Browse by field, state or major. Free, no sign-up.",
        "Browse internships", [root], hub, ld=[ORGANIZATION, WEBSITE])
    # was: "Browse internships", [root], hub)   (no JSON-LD: a one-item breadcrumb is none, see page)

    # What InternScout is, for people and for answer engines (2026-10-02). After the hubs: they link
    # only pages that exist.
    qa = about_answers(facts, len(majors_made), len(new), rep)
    t_, d_, b_, ld_ = about_page(facts, qa, updated)
    add("/about/", t_, d_, "About InternScout", [("/", "InternScout"), ("/about/", "About")], b_, ld=ld_)
    t_, d_, b_ = compare_page(facts)
    add("/compare/", t_, d_, "InternScout vs Simplify vs Jobright", [("/", "InternScout"), ("/compare/", "Compare")], b_)
    t_, d_, b_, ld_ = pricing_page()
    add("/pricing/", t_, d_, "Plans and prices", [("/", "InternScout"), ("/pricing/", "Pricing")], b_, ld=ld_)
    global TEXTS
    made = {p["path"]: (p["h1"], len(p["items"]) if p["items"] is not None else 0) for p in pages}
    TEXTS = llms_files(facts, made, rep, len(majors_made), len(by_company), len(new), updated)
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
        # The comment (2026-10-02) only says out loud what "User-agent: *" already allows: AI search and
        # answer crawlers read the site like any other. A group of their own would change nothing, and
        # a crawler that matches a named group ignores the "*" one, so a later edit to one could
        # silently stop applying to them.
        f.write("# Every crawler is welcome, AI search and answer engines included: GPTBot, OAI-SearchBot,\n"
                "# ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, Bingbot and\n"
                f"# Applebot-Extended. A summary for language models: {SITE}/llms.txt\n"
                f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
        # was: f.write(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
        # was: f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
        #              f"Disallow: /data/\n\nSitemap: {SITE}/sitemap.xml\n")
    # llms.txt and llms-full.txt (2026-10-02): not in the sitemap, which lists pages; answer engines
    # look for them at the root by name, and robots.txt and /about/ point to them.
    for name, text in TEXTS.items():
        with open(os.path.join(site_dir, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)


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
