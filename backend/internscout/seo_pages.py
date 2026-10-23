"""Static, crawlable landing pages built from the exported listings.

The dashboard is a client-rendered app: a search engine that fetches internscout.org sees a shell and
no internships. These pages give every field, state, field-in-a-state and UMass major its own plain
HTML page listing the open postings, so a student searching "nursing internships massachusetts" can
land on one. They are rebuilt from docs/data on every deploy (see .github/workflows/pages.yml), so
they are always as fresh as the data and are never committed.

Quality rules, because mass-produced pages that say nothing are exactly what search engines demote:
  * a page exists only when it has at least MIN_OPEN open listings;
  * a field-in-a-place page listing fewer than INDEX_COMBO is built and linked, but kept out of search
    (noindex and out of the sitemap) unless Search Console shows people finding it (2026-10-13);
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

from . import near_metros

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
# Widened 2026-10-07: the field pages draw three times the click rate of the employer pages (Search
# Console, 28 days to 2026-10-07: 6.1% against 2.0%), so there are more field-in-a-place pages where
# students look. A field in a US metro (US_METRO_PAGES) gets a page at MIN_COMBO like a state; one of
# the fields the growth plan markets first (growth/README.md, "Primary: market now": these are those
# majors' tags in majors.json) in the Northeast, remote or a metro gets one at MIN_COMBO_PRIORITY. Every
# page these rules add must also be its own list: MIN_EMPLOYERS_NEW employers at least (not one
# employer's page under a place's name), and not near_same as a page already made (the field's own
# page, the field in the metro's state, or another field in the same place).
PRIORITY_FIELDS = frozenset({"swe", "hardware", "data", "math", "finance", "operations", "supply_chain",
                             "consulting", "hr", "industrial"})
PRIORITY_PLACES = frozenset({"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "PA", "remote"})   # and the metros
MIN_COMBO_PRIORITY = 10
MIN_EMPLOYERS_NEW = 3
# Two pages whose full role lists overlap this much (shared roles over all roles of either, so a page
# that holds 80% of a bigger one's roles is not "the same" until the bigger one is mostly it too) are
# one list to a reader. A page already live is folded only at SAME_SHARE, so one hovering at the line
# does not come and go between deploys (keep_at's reason).
NEAR_SAME = 0.8


def near_same(a: frozenset, b: frozenset, limit: float = NEAR_SAME) -> bool:
    return bool(a | b) and len(a & b) >= limit * len(a | b)


def keep_at(need: int) -> int:
    """A page that is already live stays until it falls to two thirds of what a new page needs, so a
    topic hovering at the line does not vanish and come back between deploys (a search engine that
    finds a URL gone drops it, and takes weeks to trust it again)."""
    return need * 2 // 3


# Which field-in-a-place pages search engines are asked to index (2026-10-13). Search Console, 28 days to
# 2026-10-13: 642 of ~1,554 pages indexed and ~687 "Discovered - currently not indexed", Google's sign that
# it is rationing its visits to the site. Measured on that day's data, the field-in-a-place pages are the
# thin end: 596 of them, a tenth with fewer than 15 roles, every role on one also on its field's page and
# its place's page; 4 of the 181 under 20 roles had a Search Console click, against 16 of the 415 at 20 or
# more. The employer pages are not thin by their count: the small ones earn impressions as often as the big
# ones (39-41% of those with 3 to 9 roles were in Search Console's top pages, 17-22% of those with 15 or
# more), since "<employer> internships" is the search. So a field-in-a-place page listing fewer than
# INDEX_COMBO roles is "noindex, follow" and left out of sitemap.xml. It is still built, linked from its
# field and place pages and given its feed, for the students who browse to it; only search engines are told
# to spend their visits elsewhere. Each deploy decides afresh, so a page that grows is indexed again.
# INDEX_SLACK: a page already in the live sitemap (indexed last deploy) stays indexed until it falls below
# INDEX_COMBO - INDEX_SLACK, so one role closing or opening does not flip it in and out of the sitemap.
# Revert: INDEX_COMBO = 0 indexes every field-in-a-place page again, as before 2026-10-13.
INDEX_COMBO = 20
INDEX_SLACK = 2
# ...and never one that people already find in search: a page Search Console lists with a click, or with
# SEARCH_KEEP_IMPRESSIONS impressions or more (backend/data/search_console_pages.json, every page in the
# metrics job's top-200 snapshots kept in D1, as of the date in the file).
SEARCH_KEEP_IMPRESSIONS = 5
SEARCH_PAGES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "search_console_pages.json")
# The noindex pages this deploy built, one path a line, at the site's root: the next deploy reads it back
# (held_paths) so a page that left the sitemap for noindex still counts as live for keep_at, and is not
# dropped as if it were new (pages.yml fetches it beside the live sitemap).
HELD_FILE = "noindex-pages.txt"


def earning_paths(path: str = SEARCH_PAGES) -> frozenset[str]:
    """The pages Search Console shows people finding (SEARCH_KEEP_IMPRESSIONS); empty without the file."""
    try:
        with open(path, encoding="utf-8") as f:
            pages = json.load(f).get("pages") or {}
    except (OSError, ValueError, AttributeError):
        return frozenset()
    return frozenset(p for p, v in pages.items()
                     if isinstance(v, dict) and (v.get("clicks", 0) > 0
                                                 or v.get("impressions", 0) >= SEARCH_KEEP_IMPRESSIONS))


def combo_indexed(n: int, path: str, live, earning: frozenset[str] = frozenset()) -> bool:
    """Whether a field-in-a-place page listing n roles is indexed (INDEX_COMBO, INDEX_SLACK)."""
    return (n >= INDEX_COMBO or path in earning
            or (path in live and n >= INDEX_COMBO - INDEX_SLACK))


# was: 10. Lowered 2026-10-01: Search Console showed "[employer] internships" is how people find the site,
# and since the employer pages carry the facts box and answers (employer_facts), a page with 5 roles
# still says something worth reading. 270 more employers qualified that day.
MIN_EMPLOYER = 5        # open roles an employer needs before it gets a page of its own
MIN_KIND = 25           # ...and a start term, paid, co-op, research or class-year page (see kinds())
PER_PAGE = 40           # listings shown on one page; the dashboard has the rest
NEW_DAYS = 7
RELATED = 12            # related-page links per section
NEW_FEED = 100          # items in /internships/new/feed.xml (the other feeds carry feeds.ITEMS)
# was: TAIL = ", from internships to co-ops and research" (the end of the opening sentence). Since
# 2026-10-05 it is a sentence of its own, after the count (see summary): the audit measured the
# opening sentences at over 25 words on the field pages.
TAIL = "from internships to co-ops and research"      # what the opening paragraph's second sentence says
# A search result shows about 60 characters of a title and 160 of a description, and cuts the rest
# mid-word. The audit of 2026-10-05 found 202 of 297 titles outside 30-60 as rendered (the suffix is
# 14 of them) and 63 descriptions outside 110-160. fit_title and fit_description keep every page in.
TITLE_MAX = 60
TITLE_SUFFIX = " | InternScout"
DESC_MIN, DESC_MAX = 110, 160

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
# US cities since 2026-10-07. Search Console's field queries read "<field> internships in <place>", and
# students name the city ("software engineering internships nyc") at least as often as the state. The
# export carries a metro only for Canada (geo.CA_METROS), so a US region is in one of these when it is
# filed in the metro's state and its location names one of the metro's towns; New York City also needs
# the region's own nyc_metro kind (region.py: within 50 miles of Midtown), so "Rochester, New York" is
# not in it. The towns are the ones the listings name (2026-10-07 export) within a short commute of the
# city. Boston is the inner ring, not eastern Massachusetts: drawn that wide it held 89% of the
# Massachusetts page's roles, the same list under a second URL (see near_same).
US_METRO_PAGES = {
    "New York City": ("NY", "new york|nyc|manhattan|brooklyn|queens|bronx|staten island|long island city"),
    "Boston": ("MA", "boston|cambridge|somerville|brookline|newton|watertown|waltham|medford|malden|everett|"
                     "chelsea|revere|quincy|arlington|belmont|needham|dedham|wellesley|lexington|burlington|"
                     "woburn|winchester|milton|braintree|canton|norwood|westwood|bedford|hanscom"),
    "San Francisco Bay Area": ("CA", "san francisco|sf|oakland|berkeley|emeryville|alameda|san jose|palo alto|"
                                     "mountain view|sunnyvale|santa clara|cupertino|menlo park|redwood city|"
                                     "redwood shores|san mateo|foster city|south san francisco|san bruno|burlingame|"
                                     "san carlos|belmont|brisbane|millbrae|fremont|newark|milpitas|los gatos|campbell|"
                                     "pleasanton|livermore|dublin|san ramon|walnut creek|hayward|union city"),
    "Los Angeles": ("CA", "los angeles|santa monica|el segundo|culver city|playa vista|venice|marina del rey|"
                          "long beach|torrance|hawthorne|manhattan beach|redondo beach|carson|inglewood|burbank|"
                          "glendale|pasadena|west hollywood|beverly hills|van nuys|northridge|seal beach|irvine|"
                          "costa mesa|huntington beach|santa ana|anaheim|newport beach"),
    "Seattle": ("WA", "seattle|bellevue|redmond|kirkland|bothell|renton|tukwila|kent|everett|mukilteo|issaquah|"
                      "auburn|seatac|tacoma|puyallup|lynnwood"),
    "Chicago": ("IL", "chicago|evanston|skokie|niles|glenview|northbrook|northfield|deerfield|lake forest|rosemont|"
                      "des plaines|schaumburg|rolling meadows|hoffman estates|elk grove village|itasca|naperville|"
                      "lisle|downers grove|oak brook|oakbrook terrace|westchester|lombard|warrenville|abbott park|"
                      "north chicago|waukegan|wood dale|bolingbrook|aurora|batavia"),
    "Austin": ("TX", "austin|round rock|cedar park|georgetown|pflugerville|taylor|leander"),
    "Dallas–Fort Worth": ("TX", "dallas|fort worth|ft\\.? worth|plano|irving|richardson|frisco|arlington|addison|"
                                "carrollton|coppell|westlake|grapevine|lewisville|mckinney|allen|garland|grand prairie|"
                                "north richland hills|las colinas|denton|southlake"),
    "Houston": ("TX", "houston|the woodlands|spring|sugar land|katy|pasadena|pearland|baytown|deer park|la porte|"
                      "texas city|kingwood|humble|cypress|conroe|galveston"),
    "Atlanta": ("GA", "atlanta|atl|alpharetta|duluth|dunwoody|suwanee|johns creek|kennesaw|norcross|marietta|"
                      "sandy springs|buford|peachtree corners|lawrenceville|roswell|smyrna|decatur"),
    "Denver": ("CO", "denver|boulder|golden|westminster|lakewood|centennial|broomfield|lone tree|greenwood village|"
                     "littleton|englewood|louisville|lafayette|aurora|arvada|thornton|highlands ranch|longmont|superior"),
    "Philadelphia": ("PA", "philadelphia|king of prussia|conshohocken|malvern|wayne|radnor|bala cynwyd|ardmore|exton|"
                           "fort washington|horsham|blue bell|collegeville|spring house|west point|plymouth meeting|"
                           "ridley park|west chester|newtown square|berwyn"),
    "Pittsburgh": ("PA", "pittsburgh|canonsburg|cranberry|coraopolis|moon township|warrendale|murrysville|"
                         "bridgeville|wexford"),
}
_US_METRO_TOWNS = {m: re.compile(rf"\b(?:{towns})\b", re.I) for m, (_, towns) in US_METRO_PAGES.items()}
# Every metro page's state or province: the dashboard opens on it, and a page names a town without it.
METRO_STATE = {**CA_METRO_PAGES, **{m: st for m, (st, _) in US_METRO_PAGES.items()}}


def us_metro(g: dict) -> str | None:
    """The US metro (US_METRO_PAGES) a region is in, or None."""
    for m, (st, _) in US_METRO_PAGES.items():
        if (g.get("state") == st and (m != "New York City" or g.get("kind") == "nyc_metro")
                and _US_METRO_TOWNS[m].search(str(g.get("loc") or ""))):
            return m
    return None


US_STATES.update(CA_PROVINCES)
US_STATES.update({"Canada": "Canada", **{m: m for m in CA_METRO_PAGES}, **{m: m for m in US_METRO_PAGES}})
CANADA_KEYS = set(CA_PROVINCES) | {"Canada"}
# was: set(US_STATES) - {"remote"}. "Canada" and the metros are views over the provinces, not places
# a posting is filed in, so they do not count toward how widely a posting is spread.
# was: ... - set(CA_METRO_PAGES); the US metros (2026-10-07) are views over their states the same way.
PLACES = set(US_STATES) - {"remote", "Canada"} - set(METRO_STATE)      # the states a posting can be filed in

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
# The long field titles as a title tag can carry them when the full one won't fit beside a state
# ("Environmental Science and Engineering Internships in Pennsylvania" is 65 characters on its own).
# Each is what students search for; fit_title falls back to it only when the full title is too long.
FIELD_SHORT = {"ml": "Machine Learning", "data": "Data Science", "environmental": "Environmental",
               "government": "Government", "law": "Law"}


def field_title(tag: str) -> str:
    return FIELD_TITLES.get(tag, (tag.replace("_", " ").title(), None))[0]


def field_short(tag: str) -> str:
    return FIELD_SHORT.get(tag, field_title(tag))


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
        # A US metro is named on the region the way the export names a Canadian one (2026-10-07), so
        # place(), places() and city_name read both alike.
        for g in regions:
            m = us_metro(g) if isinstance(g, dict) and g.get("kind") != "canada" else None
            if m:
                g["metro"] = m
                x["keys"].add(m)
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
    # Two sentences since 2026-10-05: the count, then the range. was: one sentence, "{count} {what}{where}{tail}."
    parts = [f"{plural(n, 'open student role')} {what}{where}."] + ([f"They range {tail}."] if tail else [])
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


def fit_title(*forms: str) -> str:
    """The page's <title>: the first of `forms` (longest first) that fits TITLE_MAX with TITLE_SUFFIX,
    else the first that fits without it, else the last form cut at a word (never mid-word). Callers
    pass the forms shortest-last, each with the main query term first, so "Mechanical Engineering
    Internships in Massachusetts – 120 Open | InternScout" (76 characters) loses the count, then the
    suffix, and never its subject. 2026-10-05."""
    seen: list[str] = []
    for f in forms:
        f = " ".join((f or "").split())
        if f and f not in seen:
            seen.append(f)
    for f in seen:
        if len(f) + len(TITLE_SUFFIX) <= TITLE_MAX:
            return f + TITLE_SUFFIX
    for f in seen:
        if len(f) <= TITLE_MAX:
            return f
    cut = seen[-1][:TITLE_MAX + 1].rsplit(" ", 1)[0][:TITLE_MAX]
    return cut.rstrip(" ,;:–-(")


# A sentence ends at ".", "!" or "?" followed by space and a capital or figure; "St. Luke's", "U.S."
# and "Dr." are abbreviations, not ends (the one- or two-letter capitalised word before the stop).
_SENTENCE_END = re.compile(r"(?<=[^\s.][.!?])\s+(?=[A-Z0-9$])")
_ABBREVIATION = re.compile(r"\b[A-Z][a-z]?\.$")
# What fit_description adds to a short description, in this order, each only when the text does not
# already say it (the marker). Every one is true of every page.
# was: ("Every role links to the employer's own posting.", "employer's own"): not true of a page holding
# one of the few roles that link to a job site (own_posting). 2026-10-13
DESC_PADS = (("Each role links straight to its posting.", "links straight to"),
             ("Updated several times a day.", "several times a day"),
             ("Free, no sign-up.", "no sign-up"))


def fit_description(text: str) -> str:
    """A meta description of DESC_MIN to DESC_MAX characters. Over the limit, it ends at the last
    sentence end that fits, or at a word with an ellipsis when even the first sentence is too long (an
    employer page whose three places are street addresses); under it, DESC_PADS adds a short true
    sentence. 2026-10-05."""
    text = " ".join(text.split())
    if len(text) > DESC_MAX:
        ends = [m.start() for m in _SENTENCE_END.finditer(text)
                if m.start() <= DESC_MAX and not _ABBREVIATION.search(text[:m.start()])]
        if ends:
            text = text[:max(ends)]
        else:
            text = text[:DESC_MAX].rsplit(" ", 1)[0].rstrip(" ,;:–-(") + "…"
    for pad, marker in DESC_PADS:
        if len(text) >= DESC_MIN:
            break
        if marker not in text.lower() and len(text) + 1 + len(pad) <= DESC_MAX:
            text += " " + pad
    return text


# ---- search-result titles and descriptions written for clicks (2026-10-13)
# Search Console, 28 days to 2026-10-13: 12,682 impressions, 166 clicks (1.31%), average position 9.3.
# The employer pages had 4,855 of the 5,990 impressions on the top 200 pages, at a 2.3% click rate, on
# searches worded "<employer> internships" or "<employer> internships summer 2027". So a title now
# starts with that phrase, whole ("Under Armour Internships Summer 2027"), and what follows it is
# dropped in a fixed order: the brand first, then the count, then the term; the employer or field and
# "Internships" never. The count in a title is a floor ("10+ Open", COUNT_STEPS) rather than the exact
# number: a title is what a search engine caches, and an exact count that moves on every data refresh
# would rewrite it every few hours and show a stale number most of the time. The exact count, the
# places, the pay and the newest posting's date go in the description, which engines refresh freely.
# No dash separates anything in these titles and descriptions: a colon in titles, a hyphen in pay ranges
# (a place's own name keeps its dash: Dallas–Fort Worth).

# A title's count is the largest of these at or under the real one ("10+" for 10 to 14). Under 10 a
# title names no count: "5+ Open" over a page of 9 undersells it, and the exact 9 would churn.
COUNT_STEPS = (10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750,
               1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000)
# The length the new descriptions aim for: a desktop result shows about 155 characters before it cuts
# (DESC_MAX, 160, stays the hard limit fit_description holds every page to).
DESC_AIM = 155


class Head(str):
    """A title already fitted (fit_head): add() uses it as it is, rather than fitting it again."""


def count_floor(n: int) -> str:
    """ "10+" for 10 to 14 roles, "1,000+" for 1,000 to 1,499; "" under the smallest step (a title then
    names no count, rather than "5+ Open")."""
    steps = [s for s in COUNT_STEPS if s <= n]
    if not steps:
        return ""
    floor = n // 5000 * 5000 if n >= 10000 else steps[-1]
    return f"{floor:,}+"


def fit_head(subjects: list[str], tails: list[str] = ()) -> Head:
    """A <title> of at most TITLE_MAX characters. `subjects` are the search phrase, fullest first
    ("Under Armour Internships Summer 2027", then "Under Armour Internships"); `tails` what may follow
    it, fullest first (": 10+ Open Roles", ": 10+ Open"). The first that fits, trying each subject with
    every tail and the brand, then every tail without the brand, then the brand alone, then the subject
    alone: the brand goes first, the tail next, the subject's own extra words last. When even the last
    subject is too long, it is cut at a word (fit_title), never mid-word."""
    subjects = [" ".join((s or "").split()) for s in subjects]
    subjects = [s for s in subjects if s]
    tails = [t for t in tails if t]
    for s in subjects:
        for c in [s + t + TITLE_SUFFIX for t in tails] + [s + t for t in tails] + [s + TITLE_SUFFIX, s]:
            if len(c) <= TITLE_MAX:
                return Head(c)
    return Head(fit_title(subjects[-1]) if subjects else "InternScout")


def pack(leads: list[str], extras: list[str], need: int = 2, aim: int = DESC_AIM) -> str:
    """A description from one opening sentence and optional ones. `leads` is the opening sentence,
    fullest first (three places, two, one, none); `extras` the optional sentences, most important first.
    The fullest lead with which the first `need` extras all fit wins (pay and the newest posting
    outrank a second or third place); then every other extra that fits, in order. Under DESC_MIN, the
    extras that did not fit are tried against DESC_MAX as well, and fit_description pads the rest."""
    leads = [" ".join(x.split()) for x in leads if x]
    extras = [" ".join(x.split()) for x in extras if x]
    must = extras[:need]
    lead = next((x for x in leads if len(" ".join([x, *must])) <= aim), leads[-1])
    text = lead
    for limit in (aim, DESC_MAX):
        for e in extras:
            if e not in text and len(text) + 1 + len(e) <= limit:
                text += " " + e
        if len(text) >= DESC_MIN:
            break
    return text


def possessive(name: str) -> str:
    """ "Bose's", "Mars's"; "the employer's" for a name too long or too odd to read well that way."""
    return "the employer's" if len(name) > 24 or not name[-1:].isalnum() else f"{name}'s"


def pay_words(pay: tuple | None) -> str:
    """ "Listed pay $22-$51.25/hr." from an hourly_range, or ""."""
    if not pay:
        return ""
    lo, hi = pay[0], pay[1]
    return f"Listed pay {money(lo)}/hr." if lo == hi else f"Listed pay {money(lo)}-{money(hi)}/hr."


def employer_title(name: str, n: int, term: str | None) -> Head:
    """ "Under Armour Internships Summer 2027: 10+ Open | InternScout". The term is the one most of the
    employer's roles share (main_term), so it is whatever that is, Spring 2027 or Fall 2026 as well."""
    many = count_floor(n)
    subjects = [f"{name} Internships {term}" if term else "", f"{name} Internships"]
    if many:
        return fit_head(subjects, [f": {many} Open Roles", f": {many} Open"])
    # Under COUNT_STEPS[0] roles, "Open Roles" without a number, where it fits with the brand: it still
    # says the page lists live openings (not reviews or salaries), and "Biogen Internships | InternScout"
    # left half the title unused. Without a number it is worth less than the brand, so it goes first.
    head = fit_head(subjects, [": Open Roles"])
    return head if head.endswith(TITLE_SUFFIX) else fit_head(subjects)


def employer_description(name: str, n: int, term: str | None, named: list[str], pay: tuple | None,
                         newest: datetime | None, co_ops: int = 0, own_links: bool = True) -> str:
    """The employer page's description: what the employer's own careers page does not show in one
    place. The exact count, the term, up to three places, the listed pay, how recently the newest role
    was posted, then why InternScout: free, and every role links to the employer's own posting, said
    only when `own_links` (no role on the page links to a job site instead, own_posting)."""
    own = possessive(name)
    if n <= 0:
        return pack([f"No {name} internships are open right now."],
                    [f"InternScout checks {own} public job boards several times a day and lists new roles "
                     "here as they open.", "Free, no sign-up."], need=0)
    what = ("co-op" if co_ops else "internship") if n == 1 else f"internships{' and co-ops' if co_ops else ''}"
    head = f"{n:,} open {name} {what}" + (f" for {term}" if term else "")
    leads = [head + (f" in {join_words(named[:k])}" if k else "") + "." for k in (3, 2, 1, 0) if k <= len(named)]
    newest_txt = f"Newest posted {newest:%b} {newest.day}." if newest else ""
    return pack(leads, [pay_words(pay), newest_txt, "Free, no sign-up.",
                        f"Every role links to {own} own posting." if own_links else ""],
                need=len([x for x in (pay, newest) if x]))


# Job sites that repost other employers' roles. A few listings (from search results) link to one of
# these instead of the employer's own posting (13 of about 18,600 on 2026-10-13), so a page says "links
# to <employer>'s own posting" only when none of its roles does.
JOB_SITE_HOSTS = ("linkedin.com", "indeed.com", "simplify.jobs", "joinhandshake.com", "bebee.com",
                  "ziprecruiter.com", "glassdoor.com", "monster.com", "careerbuilder.com", "lensa.com",
                  "talent.com", "dice.com", "jobright.ai", "wayup.com", "builtin.com")


def own_posting(x: dict) -> bool:
    """Whether a listing's apply link is on the employer's own site or its application system, not a
    job site that reposts it (JOB_SITE_HOSTS)."""
    host = (urlparse(x.get("apply_url") or "").hostname or "").lower()
    return bool(host) and not any(host == h or host.endswith("." + h) for h in JOB_SITE_HOSTS)


def hiring_words(items: list[dict], k: int = 3) -> str:
    """ "Hiring now: TikTok, Tesla, ByteDance and 412 more." from the k employers with the most roles."""
    counts = Counter(x["company_name"] for x in items if x.get("company_name") and real_company(x["company_name"]))
    names = top(counts, k)
    if not names:
        return ""
    rest = len({employer_key(c) for c in counts}) - len({employer_key(c) for c in names})
    return (f"Hiring now: {', '.join(names)} and {rest:,} more." if rest > 0
            else f"Hiring now: {join_words(names)}.")


def listing_title(subjects: list[str], n: int, tail: str = "Open") -> Head:
    """A field, place or field-in-a-place title: "Software Engineering Internships: 2,000+ Open"."""
    many = count_floor(n)
    return fit_head(subjects, [f": {many} {tail}"] if many else [])


def listing_description(n: int, what: str, where: str, items: list[dict], updated: str,
                        audience: bool = True) -> str:
    """A field, place or field-in-a-place description: "318 open machine learning and AI internships
    in California, most for Summer 2027. Hiring now: ... Updated October 13, 2026. Free, no sign-up."
    `what` is the plural noun phrase ("machine learning and AI internships and co-ops"), `where` the
    place after it ("in California", or "")."""
    term = main_term(items)
    tail = f", most for {term}" if term else ""
    noun = what if n != 1 else re.sub(r"\binternships\b", "internship", what, count=1)
    full = f"{n:,} open {noun}{' for college students' if audience else ''}{' ' + where if where else ''}{tail}."
    short = f"{n:,} open {noun}{' ' + where if where else ''}{tail}."
    # Fewer employers named, then the shorter opening, until both fit: three long employer names
    # ("Internal Revenue Service, Aramco Americas, ...") would otherwise crowd out the employers entirely.
    leads = [" ".join([lead, hiring_words(items, k)]) for k in (3, 2, 1) for lead in (full, short)] + [full, short]
    return pack(leads, [f"Updated {updated}.", "Free, no sign-up."], need=0)


EMPLOYERS: dict[str, str] = {}   # every spelling of a company's name -> its employer page, set by build()

# Trailing words that name the same employer differently: "Magna International" is Magna, "The Boeing
# Company" is Boeing. Only whole trailing words go, so "Bank of America" keeps its name.
_SUFFIX = re.compile(r"\s+(inc|incorporated|llc|ltd|co|company|corp|corporation|international|group|holdings|plc|lp)$")
EMPLOYER_ALIASES = {"booz allen hamilton": "booz allen"}
STUDENT_STAGES = {"internship", "co_op", "research", "fellowship"}


# A company name a job board filled with something else (2026-10-07): "APPLY NOW" headed a row of the
# Summer 2027 tracker (a Jobilize listing). Nothing upstream cleans names, so this is conservative: a
# name with no letters, or one made only of call-to-action or placeholder words, is not an employer.
# "PGA TOUR", "C3 AI" and "HP IQ" are real; only whole names made of these words are dropped.
_NOT_A_NAME = frozenset({"apply", "now", "here", "click", "today", "view", "see", "more", "details", "learn",
                         "hiring", "job", "jobs", "career", "careers", "opening", "openings", "position",
                         "positions", "confidential", "undisclosed", "unknown", "n", "a", "na", "tbd",
                         "company", "name", "employer", "various", "multiple", "not", "specified"})


def real_company(name: str) -> bool:
    words = re.findall(r"[a-z]+", (name or "").lower())
    return bool(words) and not set(words) <= _NOT_A_NAME


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


# The weekly email's "new" count (2026-10-06): moved here from growth/digest.py, which still names
# them (digest.unique_roles, digest.new_roles), so the sign-up forms on the pages built here can quote
# the email's own number without importing growth/. One rule, one copy.
DIGEST_MIN_NEW = 3     # new roles a field needs in a week to get a section in the email (was: digest.MIN_NEW = 3)


def unique_roles(items: list[dict]) -> list[dict]:
    """One row per role. dedupe_roles matches on title and place, so it runs within each employer:
    two companies that each post a "Software Engineering Intern" in Boston are two roles."""
    by_employer: dict[str, list[dict]] = {}
    for x in items:
        by_employer.setdefault(employer_key(x.get("company_name") or ""), []).append(x)
    return [x for group in by_employer.values() for x in dedupe_roles(group)]


def new_roles(d: dict, now: datetime) -> list[dict]:
    """This week's new roles, as every growth output counts them: found this week by fresh (the
    rule /internships/new/ uses), then one row per role within each employer (unique_roles). The
    digest's subject, the brand posts' counts, the dashboard metrics and the sign-up forms' numbers
    all use this one number. stats.json's "new" (export_static's is_new) counts every listing a scan
    first saw in the last week, before either step, so it runs a little higher; it is the dashboard's
    own badge count."""
    return unique_roles([x for x in d["listings"] if fresh(x, now, d["baseline"])])


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
                    "title": f"{t} Internships", "tails": [": {n} Open Now", ": {n} Open"],
                    "desc": f"{{n}} open {t} internships, co-ops and research roles for college students, "
                            "updated {updated}. Northeast and remote first. Free search, no sign-up.",
                    "pick": lambda x, t=t: x.get("term") == t, "dash": {}, "about": frozenset({"term"})})
    stage = lambda s: lambda x: s in (x.get("stage") or [])          # noqa: E731
    year = lambda y: lambda x: y in (x.get("years") or [])           # noqa: E731
    years_note = ("<p class=\"more\">Most postings don't say which class years they take, so this page is "
                  "only the ones that do. The dashboard's “Eligible year” filter keeps the rest as well.</p>")
    out += [
        {"slug": "paid", "h1": "Paid internships", "crumb": "Paid", "what": "that list pay or say they are paid",
         "title": "Paid Internships", "tails": [": {n} Open with Pay Listed", ": {n} Open"],
         "desc": "{n} open internships, co-ops and research roles that list pay or say they are paid, updated "
                 "{updated}. Free search for college students, no sign-up.",
         "pick": is_paid, "dash": {"paid": True}, "about": frozenset({"paid"})},
        {"slug": "co-op", "h1": "Co-op jobs and internships", "crumb": "Co-ops", "what": "that are co-ops",
         "tail": "", "title": "Co-op Jobs and Internships", "tails": [": {n} Open"],
         "desc": "{n} open co-ops for college students, updated {updated}. Northeast and remote first. "
                 "Free search, no sign-up.",
         "pick": stage("co_op"), "dash": {"stage": "co_op"}, "about": frozenset({"co_op"})},
        {"slug": "research", "h1": "Research internships for undergraduates", "crumb": "Research",
         "what": "in research", "tail": "", "title": "Research Internships for Undergraduates", "tails": [": {n} Open"],
         "desc": "{n} open research positions for undergraduates, updated {updated}. Free search, no sign-up.",
         "note": "<p class=\"more\">Paid summer research programs (REUs) funded by the National Science "
                 "Foundation are listed on the <a href=\"https://www.nsf.gov/funding/initiatives/reu\">NSF's "
                 "REU page</a>; many apply through their own sites.</p>",
         "pick": stage("research"), "dash": {"stage": "research"}, "about": frozenset({"research"})},
        {"slug": "for-freshmen", "h1": "Internships for freshmen", "crumb": "Open to first-years",
         "what": "whose postings say they take first-year students",
         "title": "Internships for Freshmen", "tails": [": {n} Open to First-Years", ": {n} Open"],
         "desc": "{n} open internships and programs whose postings say they take first-year college "
                 "students, updated {updated}. Free search, no sign-up.",
         "note": years_note, "pick": year("first_year"), "dash": {"year": "first_year"}},
        {"slug": "for-sophomores", "h1": "Internships for sophomores", "crumb": "Open to sophomores",
         "what": "whose postings say they take sophomores",
         "title": "Internships for Sophomores", "tails": [": {n} Open"],
         "desc": "{n} open internships and programs whose postings say they take sophomores, updated "
                 "{updated}. Free search, no sign-up.",
         "note": years_note, "pick": year("sophomore"), "dash": {"year": "sophomore"}},
    ]
    return out


# ---- "Summer 2027: who's open now" (2026-10-07)
# Recruiting for a summer runs from the summer before it, and students ask which companies have opened
# yet ("which companies have opened summer 2027 internships", "summer 2027 internships open now"). The
# term page lists the roles; this one lists the employers, newest-opened first, each with the day its
# first role for that summer was posted or found and how many it has open. Rebuilt with every deploy.

def upcoming_summers(terms, now: datetime) -> list[str]:
    """The "Summer YYYY" terms among `terms` still ahead: this year's until May is out, then next year's."""
    return sorted(t for t in terms if (m := re.match(r"^Summer (\d{4})$", str(t or "")))
                  and (int(m[1]) > now.year or (int(m[1]) == now.year and now.month <= 5)))


def tracker_path(term: str) -> str:
    return f"/internships/{slugify(term)}/open/"


def opened_on(x: dict, year: int, baseline: str | None) -> tuple | None:
    """(day, exact) a role for the summer of `year` first appeared: the earlier of its posting date and
    the day a scan first found it. A posting date before the year ahead of the summer is a requisition
    an employer keeps reopening (57 Summer 2027 roles on 2026-10-07 carried dates from 2016 to 2025),
    not the day this summer opened, so it is left out. A first_seen on or before `baseline` (or a
    Canadian role from the first Canadian scan, canada_first_scan) only says the role was open by then:
    exact is False, and the page says "by"."""
    days = []
    posted, seen = _when(x.get("posted_at")), _when(x.get("first_seen"))
    if posted and posted.year >= year - 1:
        days.append((posted.date(), True))
    if seen:
        floor = bool(baseline and str(x.get("first_seen"))[:10] <= baseline) or canada_first_scan(x)
        days.append((seen.date(), not floor))
    # The earliest day; on a tie the exact one, so a role posted on the baseline day reads as that day.
    return min(days, key=lambda d: (d[0], not d[1])) if days else None


def opened_rows(items: list[dict], year: int, baseline: str | None) -> list[tuple]:
    """One row per employer with roles in `items`: (day, exact, name, page or None, roles), newest-opened
    first. One employer's spellings are one row (employer_key), named as its employer page is."""
    groups: dict[str, list] = {}
    for x in items:
        if x.get("company_name") and real_company(x["company_name"]):      # not "APPLY NOW" (real_company)
            groups.setdefault(employer_key(x["company_name"]), []).append(x)
    rows = []
    for _, its in sorted(groups.items()):
        names = Counter(x["company_name"] for x in its)
        path = next((EMPLOYERS[n] for n in sorted(names) if n in EMPLOYERS), None)
        name = min(names, key=lambda n: (-names[n], len(n), n))
        days = [d for d in (opened_on(x, year, baseline) for x in its) if d]
        if not days:
            continue
        day, exact = min(days, key=lambda d: (d[0], not d[1]))
        rows.append((day, exact, name, path, len(dedupe_roles(its))))
    return sorted(rows, key=lambda r: (-r[0].toordinal(), not r[1], r[2].lower(), r[2]))


def short_day(day) -> str:
    return f"{day:%b} {day.day}, {day.year}"


def tracker_page(term: str, rows: list[tuple], roles: int, now: datetime, updated: str,
                 term_path: str) -> tuple[str, str, str, str]:
    """(title, description, h1, body) for one summer's tracker."""
    today = now.astimezone(timezone.utc).date()
    week = [r for r in rows if r[1] and (today - r[0]).days < NEW_DAYS]
    n = len(rows)
    lead = (f"As of {updated}, {plural(n, 'employer has', 'employers have')} opened {esc(term)} internships, "
            f"with {roles:,} open roles between them; {len(week):,} opened this week.")
    honest = ("These are employers InternScout found on public job boards, not every employer that will hire "
              f"for {esc(term)}. Newest first: “Opened” is the day the employer’s first {esc(term)} role was "
              "posted or found.")
    floor_note = ""
    if any(not r[1] for r in rows):
        floor_note = ("<p class=\"more\">A date with “by” is the day InternScout began recording when it first "
                      f"finds a posting ({long_day(FIRST_SEEN_SINCE)}, or {long_day(CANADA_SINCE)} for roles in "
                      "Canada, which it added that day): those roles were already open then, perhaps for weeks.</p>")
    trs = []
    for day, exact, name, path, k in rows:
        who = f"<a href=\"{esc(path)}\">{esc(name)}</a>" if path else esc(name)
        when = short_day(day) if exact else f"By {short_day(day)}"
        trs.append(f"<tr><td>{who}</td><td class=\"num\">{when}</td><td class=\"num\">{k:,}</td></tr>")
    body = (f"<p class=\"lede\">{lead}</p><p class=\"more\">{honest}</p>"
            f"<a class=\"cta\" href=\"{term_path}\">See every {esc(term)} role</a>"
            + tablewrap(f"Employers with {term} roles") + "<table class=\"data\"><thead><tr><th>Employer</th><th>Opened</th>"
            f"<th>{esc(term)} roles</th></tr></thead><tbody>" + "".join(trs) + "</tbody></table></div>"
            + floor_note
            + "<p class=\"follow\">Roles found in the last week, whatever the term: "
              "<a href=\"/internships/new/\">new internships this week</a>. "
              "Every employer with five or more open roles: <a href=\"/internships/at/\">internships by employer</a>.</p>")
    # 2026-10-13: a count floor (count_floor) that holds between refreshes; the exact count is in the
    # description. was: [f"{term} Internships Open Now: {n:,} Employers", f"Which Companies Have Opened
    # {term} Internships", f"{term} Internships Open Now"], whose first form never fit.
    many = count_floor(n)
    title = fit_head([f"{term} Internships Open Now"], [f": {many} Companies"] if many else [])
    desc = (f"{n:,} companies with {term} internships open now, found on public job boards, newest first "
            f"with the day each opened. {len(week):,} opened this week. Updated {updated}.")
    return title, desc, f"{term} internships: who’s open now", body


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
        new_tag = ' <span class="new">New</span>' if new else ""
        href = esc(safe_url(x["apply_url"]))
        # On a site Auto-Apply fills, a quiet second link to the install page (2026-10-04). Internal,
        # so a page of 40 rows is not 40 outbound store links; the page's one store link is autoapply_card.
        # It names the listing (listing=<id>, 2026-10-14, D21), so the install flow can carry this posting
        # through. was: href="/install.html?from={src}-row", the same for every row.
        aa = (f' <a class="aa" href="/install.html?from={esc(src)}-row&amp;listing={esc(quote(str(x["id"]), safe=""))}">'
              'Auto-Apply this</a>' if autofills(x) and x.get("id") is not None else "")
        # data-aa (2026-10-13): js/offer.js may offer the extension when this posting is opened.
        rows.append(
            '<li class="job">'
            f'<div class="co">{company_link(x.get("company_name") or "", here)}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{row_meta(x, state)}</div>'
            # The two actions sit on one line in .acts (2026-10-14, D21): "Open posting" a secondary button,
            # "Auto-Apply this" a quiet link after it, as on the dashboard's rows.
            # was: f'<a class="go"{go_aa(x)} href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>{aa}'
            f'<div class="acts"><a class="go"{go_aa(x)} href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>{aa}</div>'
            "</li>")
    return "\n".join(rows)


def row_meta(x: dict, state: str | None = None) -> str:
    """A row's grey line, HTML: place, term, stage and pay. The same for a listing row and a paid
    listing's box (placement_box), so the two can never describe one role differently."""
    stage = ", ".join(s.replace("_", "-") for s in (x.get("stage") or []) if s != "internship")
    meta = [esc(place(x, state))]
    if x.get("term"):
        meta.append(esc(str(x["term"])))
    if stage:
        meta.append(esc(stage))
    pay = esc(pay_text(x))       # was: esc(str(x["salary"])) if x.get("salary") else ("Paid" if is_paid(x) else "")
    pay_tag = f' · <span class="pay">{pay}</span>' if pay else ""
    return " · ".join(meta) + pay_tag


def autofills(x: dict) -> bool:
    """Whether Auto-Apply fills this listing's application with no extra permission: a system it knows,
    on that system's own host (extension/lib/hosts.js isAtsHost). 2026-10-04."""
    if x.get("ats") not in SUPPORTED_ATS:
        return False
    host = (urlparse(x.get("apply_url") or "").hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in AUTOFILL_HOSTS)


# The Auto-Apply offer (2026-10-13): docs/js/offer.js shows a slim "Add to Chrome" bar in this tab when
# a student opens a posting whose a.go link carries data-aa (go_aa), on a desktop Chromium browser
# without the extension, at most once a session and not for 14 days after it is dismissed. page() adds
# the script only to a page with such a link, so a page with none carries nothing extra.
OFFER_TAG = '<script defer src="/js/offer.js"></script>'
OFFER_MARK = '<a class="go" data-aa '


def go_aa(x: dict) -> str:
    """ ' data-aa' for a posting link whose application Auto-Apply fills (autofills), else ''."""
    return " data-aa" if autofills(x) else ""


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
            f"<a class=\"cta secondary ext-desk\" href=\"{STORE_URL}?utm_source={esc(src)}\">{label}</a>"
            f"<a class=\"cta secondary ext-touch\" href=\"/install.html?from={esc(src)}\">{label}</a></div>")


def company_link(name: str, here: str | None = None) -> str:
    """The company's name, linked to its employer page when it has one (here: this page's path)."""
    path = EMPLOYERS.get(name)
    return f'<a href="{esc(path)}">{esc(name)}</a>' if path and path != here else esc(name)


EMPLOYER_PLACES = 6     # field-in-a-place pages an employer page links (2026-10-07)


# Places read with "the" after "in" (2026-10-07): "internships in the San Francisco Bay Area".
PLACE_THE = frozenset({"San Francisco Bay Area", "NT"})
# ...and the shorter name a title falls back to when the full one won't fit beside a long field, as
# FIELD_SHORT does for fields: "Software Engineering Internships in the San Francisco Bay Area" is 62.
PLACE_SHORT = {"San Francisco Bay Area": "in the Bay Area"}


def in_place(k: str) -> str:
    """ "in Boston", "in the San Francisco Bay Area": a place after "in", as a sentence or title says it."""
    return f"in {'the ' if k in PLACE_THE else ''}{US_STATES[k]}"


def combo_label(t: str, k: str) -> str:
    """A field-in-a-place page as a link names it: "Software Engineering in Boston"."""
    return f"{field_title(t)} (Remote)" if k == "remote" else f"{field_title(t)} {in_place(k)}"


def link_list(title: str, links: list[tuple[str, str, int]]) -> str:
    if not links:
        return ""
    lis = "".join(f"<li><a href=\"{esc(href)}\">{esc(label)}</a> <span class=\"n\">{n:,}</span></li>"
                  for href, label, n in links)
    return f"<section class=\"rel\"><h2>{esc(title)}</h2><ul>{lis}</ul></section>"


# The dashboard's tokens (docs/index.html), since 2026-10-14 the whole block: colours, the eight type sizes,
# spacing, radii, shadows, control heights and the six icons, with the self-hosted faces in docs/fonts/ (the
# site serves them at /fonts/). tests/site/tokens.test.mjs fails if this copy drifts from the dashboard's.
# was: paper, panel, ink, ink2, ink3, rule and accent only, and font names the page never loaded, so landing
# pages drew in Georgia and Segoe. accent-hover is the call-to-action's hover, a real colour
# step rather than a fade. nav spacing is a flex gap (was: margin-left on each link, which also pushed
# the first one off the header's edge when the header wrapped on a phone).
CSS = """
@font-face{font-family:"IBM Plex Sans";src:url(/fonts/ibm-plex-sans-latin.woff2) format("woff2");font-weight:100 700;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Source Serif 4";src:url(/fonts/source-serif-4-latin.woff2) format("woff2");font-weight:600;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Plex Fallback";src:local("Arial"),local("ArialMT"),local("Helvetica Neue"),local("Helvetica"),local("Roboto");font-weight:400;size-adjust:100.1%;ascent-override:102.4%;descent-override:27.5%;line-gap-override:0%}
@font-face{font-family:"Plex Fallback";src:local("Arial"),local("ArialMT"),local("Helvetica Neue"),local("Helvetica"),local("Roboto");font-weight:500;size-adjust:102.1%;ascent-override:100.4%;descent-override:26.9%;line-gap-override:0%}
@font-face{font-family:"Plex Fallback";src:local("Arial Bold"),local("Arial-BoldMT"),local("Helvetica Neue Bold"),local("Helvetica Bold"),local("Roboto Bold");font-weight:600 700;size-adjust:97.2%;ascent-override:105.5%;descent-override:28.3%;line-gap-override:0%}
@font-face{font-family:"Serif Fallback";src:local("Georgia Bold"),local("Georgia-Bold");font-weight:600 700;size-adjust:86%;ascent-override:120.5%;descent-override:39%;line-gap-override:0%}
:root{--paper:#f6f4ef;--panel:#fffefb;--sunk:#efece5;--ink:#17191c;--ink2:#454a52;--ink3:#646a73;--rule:#e2ded4;--rule2:#ece9e1;--field-border:#80858c;--accent:#1d5c46;--accent-ink:#fff;--accent-hover:#164a38;--accent-soft:#e3eee8;--blue:#2b5aa0;--amber:#8c5a0f;--amber-soft:#f6ecd9;--green:#1d7549;--red:#a8362c;
--serif:"Source Serif 4","Serif Fallback",Georgia,"Times New Roman",serif;--sans:"IBM Plex Sans","Plex Fallback",system-ui,-apple-system,"Segoe UI",sans-serif;--fs-1:12px;--fs-2:13px;--fs-3:15px;--fs-4:16px;--fs-5:18px;--fs-6:22px;--fs-7:28px;--fs-8:34px;--lh:1.5;--lh-head:1.2;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;--r-sm:4px;--r:6px;--r-lg:8px;--r-pill:999px;--shadow-pop:0 10px 30px color-mix(in srgb,var(--ink) 14%,transparent);--ring:0 0 0 1px var(--accent);--h-ctl:36px;--h-ctl-sm:32px;--h-field:40px;--ease-out:cubic-bezier(.2,.7,.3,1);--t-fast:140ms;--t-move:200ms;--i-chevron:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");--i-search:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E");--i-check:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E");--i-cross:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 6l12 12M18 6L6 18'/%3E%3C/svg%3E");--i-alert:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7.5v5.5M12 16.5v.01'/%3E%3C/svg%3E");--i-external:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/%3E%3C/svg%3E");--i-select:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23646a73' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#131416;--panel:#1a1b1e;--sunk:#232427;--ink:#ecebe6;--ink2:#b8b6af;--ink3:#95948e;--rule:#2c2d31;--rule2:#232427;--field-border:#6e7077;--accent:#7cc3a1;--accent-ink:#0f1a15;--accent-hover:#95d2b3;--accent-soft:#1c2a24;--blue:#8fb2e8;--amber:#e0b25e;--amber-soft:#2e2717;--green:#7cc3a1;--red:#e48a80;
--i-select:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2395948e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");color-scheme:dark}}
@media (pointer:coarse){:root{--h-ctl:44px;--h-ctl-sm:44px;--h-field:44px}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:var(--fs-4)/var(--lh) var(--sans)}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 64px}a{color:var(--accent)}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px 20px;flex-wrap:wrap;
padding:22px 0 14px;border-bottom:1px solid var(--ink)}
.mark{font:600 var(--fs-6)/1 var(--serif);color:var(--ink);text-decoration:none}
nav{display:flex;gap:4px 14px;flex-wrap:wrap}
nav a{color:var(--ink2);font-size:var(--fs-3);text-decoration:none;transition:color 140ms ease-out}nav a:hover{color:var(--ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.crumbs{font-size:var(--fs-3);color:var(--ink3);margin:22px 0 0}.crumbs a{color:var(--ink3)}
h1{font:600 var(--fs-8)/1.2 var(--serif);margin:10px 0 8px}
.lede{color:var(--ink2);font-size:var(--fs-5);margin:0 0 6px}.updated{color:var(--ink3);font-size:var(--fs-3);margin:0}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:var(--h-ctl);margin:18px 0 8px;padding:10px 16px;
border-radius:var(--r);border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;
transition:background-color 140ms ease-out,border-color 140ms ease-out}
.cta:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.cta:active{transform:translateY(1px)}
.cta.secondary{background:var(--panel);border-color:var(--field-border);color:var(--ink)}
.cta.secondary:hover{background:var(--panel);border-color:var(--ink3)}
.cta.quiet{background:transparent;border-color:transparent;color:var(--accent);padding-left:4px;padding-right:4px}
.cta.quiet:hover{text-decoration:underline;text-underline-offset:3px}
.cta[disabled],.cta[aria-disabled=true]{background:var(--sunk);border-color:var(--field-border);color:var(--ink3);cursor:default;transform:none}
ul.jobs{list-style:none;padding:0;margin:24px 0;border-top:1px solid var(--rule)}
.job{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.co{font-weight:600}.co a{color:var(--ink);text-decoration:none}.co a:hover{text-decoration:underline;text-underline-offset:3px}.role{grid-column:1}.meta{grid-column:1;color:var(--ink3);font-size:var(--fs-3)}
.pay{color:var(--ink2);font-variant-numeric:tabular-nums}.new{font-size:var(--fs-1);color:var(--accent);font-weight:600;margin-left:6px}
.acts{grid-column:2;grid-row:1/span 3;align-self:center;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3)}
.go{display:inline-flex;align-items:center;min-height:var(--h-ctl);padding:0 14px;border:1px solid var(--field-border);border-radius:var(--r);
background:var(--panel);color:var(--ink);font-size:var(--fs-3);font-weight:500;text-decoration:none;white-space:nowrap;transition:border-color 140ms ease-out}
.go:hover{border-color:var(--ink3)}
.more,.follow{color:var(--ink2)}section.rel h2{font:600 var(--fs-6)/1.3 var(--serif);margin:36px 0 8px}
section.rel ul{list-style:none;padding:0;margin:0;columns:2;column-gap:28px}
section.rel li{padding:3px 0;break-inside:avoid}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:20px 0 24px;padding:16px 18px;
background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}.facts dt{color:var(--ink3)}.facts dd{margin:0}
section.faq h2{font:600 var(--fs-5)/1.3 var(--serif);margin:28px 0 6px}section.faq p{margin:0;color:var(--ink2)}
@media (max-width:560px){.facts{grid-template-columns:1fr;gap:2px}.facts dd{margin-bottom:8px}}.n{color:var(--ink3);font-size:var(--fs-2)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--ink3);font-size:var(--fs-3)}
footer a{color:var(--ink2)}@media (max-width:560px){h1{font-size:var(--fs-7)}section.rel ul{columns:1}
.job{grid-template-columns:1fr}.acts{grid-column:1;grid-row:auto;margin-top:var(--s2)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.cta:active{transform:none}}
.tablewrap{overflow-x:auto;margin:16px 0 8px}table.data{width:100%;border-collapse:collapse;font-size:var(--fs-3)}
table.data th,table.data td{text-align:left;vertical-align:top;padding:9px 14px 9px 0;border-bottom:1px solid var(--rule)}
table.data thead th{border-bottom:1px solid var(--ink);font-weight:600}table.data td.num{white-space:nowrap}
section.prose h2{font:600 var(--fs-6)/1.3 var(--serif);margin:34px 0 6px}.src{color:var(--ink3);font-size:var(--fs-3)}
table.cmp{min-width:620px}@media (max-width:560px){table.data{font-size:var(--fs-3)}table.data th,table.data td{padding-right:10px}}
.aa-card{margin:18px 0 0;padding:14px 18px 6px;background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
.aa-card p{margin:0;color:var(--ink2)}.aa-card .cta{margin:10px 0 8px}
figure.chart{margin:8px 0 18px}figure.chart img{display:block;max-width:100%;height:auto}
figure.chart figcaption{color:var(--ink3);font-size:var(--fs-3);margin-top:4px}
.ext-touch{display:none}@media (pointer:coarse) and (hover:none){.ext-desk{display:none}.ext-touch{display:inline-block}}
.aa{display:inline-flex;align-items:center;min-height:var(--h-ctl);font-size:var(--fs-2);font-weight:500;color:var(--accent);text-decoration:none;white-space:nowrap}
.aa:hover{text-decoration:underline;text-underline-offset:3px}
@media (max-width:560px){.go,.aa{min-height:44px}}
main>h1:first-child{margin-top:var(--s6)}.vh{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0 6px}
.tier{position:relative;display:flex;flex-direction:column;padding:20px 18px 16px;background:var(--panel);
border:1px solid var(--rule);border-radius:var(--r-lg)}.tier.pick{border-color:var(--accent);box-shadow:var(--ring)}
.tier h2{font:600 var(--fs-6)/1.2 var(--serif);margin:0}
.tier .price{font:600 var(--fs-7)/1.1 var(--serif);margin:8px 0 2px}
.tier .price span{font:var(--fs-3)/1 var(--sans);color:var(--ink3)}
.tier .blurb{color:var(--ink2);margin:0 0 10px;font-size:var(--fs-3)}
.tier ul{margin:0 0 14px;padding-left:18px;color:var(--ink2);font-size:var(--fs-3);flex:1}.tier li{margin:4px 0}
.tier .cta{margin:0;text-align:center}
.badge{position:absolute;top:-11px;left:16px;background:var(--accent);color:var(--accent-ink);font-size:var(--fs-1);
font-weight:600;padding:3px 9px;border-radius:var(--r-pill)}
.anchor{font-size:var(--fs-5);margin:20px 0 0}ul.plain{padding-left:18px;color:var(--ink2)}ul.plain li{margin:6px 0}
@media (max-width:720px){.tiers{grid-template-columns:1fr}}
form.digest{margin:28px 0 8px;padding:16px 18px;background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
form.digest h2{font:600 var(--fs-6)/1.3 var(--serif);margin:0 0 6px}form.digest p{margin:0 0 8px;color:var(--ink2)}
.check{display:flex;gap:8px;align-items:baseline;color:var(--ink2);font-size:var(--fs-3);margin:10px 0 0}
.digest-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 10px}.digest-row label{font-weight:600}
.digest-row input{flex:1 1 220px;min-width:0;max-width:340px;height:var(--h-field);padding:0 10px;border:1px solid var(--field-border);
border-radius:var(--r);background:var(--paper);color:var(--ink);font:inherit}
.digest-row .cta{margin:0;border:0;font:inherit;font-weight:600;cursor:pointer}form.digest .fine{font-size:var(--fs-3);color:var(--ink3);margin:0}
.i{display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.i-chevron{--i:var(--i-chevron)}.i-search{--i:var(--i-search)}.i-check{--i:var(--i-check)}.i-cross{--i:var(--i-cross)}.i-alert{--i:var(--i-alert)}.i-external{--i:var(--i-external)}
input[aria-invalid=true],textarea[aria-invalid=true],select[aria-invalid=true]{border-color:var(--red)}.field-err{color:var(--red);font-size:var(--fs-2);margin:var(--s1) 0 0}
input:disabled,select:disabled,textarea:disabled{color:var(--ink3);background-color:var(--sunk);cursor:default}
.paid{display:grid;grid-template-columns:1fr auto;gap:2px 16px;margin:var(--s3) 0;padding:var(--s3) var(--s4);background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
.paid-h{grid-column:1/-1;margin:0 0 var(--s1);font-size:var(--fs-2);font-weight:600;color:var(--ink2)}.paid-h a{margin-left:var(--s2);font-weight:400;color:var(--ink3)}
.ad{display:inline-block;margin-right:var(--s1);padding:0 6px;border:1px solid var(--ink3);border-radius:var(--r-sm);font-size:var(--fs-1);font-weight:600;line-height:18px;color:var(--ink2);vertical-align:1px}
.paid .go{grid-column:2;grid-row:2/span 3;align-self:center}@media (max-width:560px){.paid{grid-template-columns:1fr}.paid .go{grid-column:1;grid-row:auto;justify-self:start;margin-top:var(--s2)}}
"""
# The last four lines (2026-10-14, B2 plan section 6) are a paid listing's box (placement_box): a panel among the
# rows, headed "Paid listing", with a bordered "Ad" badge before the company name and "Open posting" where a
# row has it. The badge and heading use ink2 and ink3 on the panel, 4.5:1 or more in light and dark.
# The four lines before those (2026-10-14) are the shared icon set (.i), form errors and disabled fields, as on the
# dashboard. .cta.secondary and .cta.quiet are the secondary and quiet buttons (A2 component 1), for the
# landing lane to use where a page has more than one call to action.
# The seven lines before those (2026-10-06) are the weekly email's sign-up form (signup_form): a panel like the
# Auto-Apply card, with the email box and button on one row that wraps on a phone. The box's border is
# ink3, not rule, so the field itself can be seen (rule is too faint for a control you type into).
# The eleven lines before those (2026-10-05) are /pricing/: three tier cards in a row, the recommended one
# ringed in the accent with a "Recommended" badge (was: "Most popular"), stacked on a phone. Only its button is
# solid; the other two are .cta.secondary (2026-10-14).
# The last five lines (2026-10-02) are the tables and headed sections of /compare/ and
# /internships/highest-paying/. A wide table scrolls inside .tablewrap, never the page; the
# comparison's four wordy columns keep a readable width on a phone and scroll there instead.
# The six after them (2026-10-04) are autoapply_card and a row's "Auto-Apply this" link. The card's
# store button shows on a computer and its install-page button on a phone or tablet (install.html's
# query: touch is the primary input and nothing hovers). Since 2026-10-14 (D21, D24) a row's actions
# sit on one line in .acts, as on the dashboard: "Open posting" a secondary button, "Auto-Apply this" a
# quiet accent link, both 44px tall on a phone and 8px apart, and company names are ink on every row
# (was: "Open posting" a 22px-tall text link stacked over a grey 13px "Auto-Apply this", and names
# green and underlined only where they had an employer page). With no breadcrumb line (a one-crumb
# page) the heading keeps its distance from the header; .vh is text only a screen reader reads.

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


# ---- the weekly email's sign-up form (2026-10-06)
# The form's address is pasted in one place: CONFIG.digest.formAction in docs/index.html, which the
# dashboard's own form reads in the browser. The pages built here read it from that same file at
# build time, as beacon_from reads the analytics tags, and growth/social.py reads it the same way. So
# the address turns on every form, and the brand posts' sign-up line, at the next deploy, and there is
# no second copy to forget. While it is empty no page gets a form at all: it is left out of the HTML,
# not hidden by a script, so it is absent with JavaScript off too.
# Only a line that starts with "digest:", so a comment that mentions the setting can't be read as it.
_DIGEST_ACTION = re.compile(r"^\s*digest\s*:\s*\{[^{}\n]*?\bformAction\s*:\s*\"([^\"\n]*)\"", re.M)
# Buttondown's embed-subscribe address, whose last part is the newsletter's username.
_BUTTONDOWN_FORM = re.compile(r"^https://buttondown\.(?:com|email)/api/emails/embed-subscribe/([A-Za-z0-9_-]+)/?$")
DIGEST_PATH = "/digest/"


def digest_form_action(site_dir: str) -> str:
    """CONFIG.digest.formAction from <site_dir>/index.html, or "" while it is empty, missing, or not an
    https address (the test js/app.js makes before it shows its own form)."""
    try:
        with open(os.path.join(site_dir, "index.html"), encoding="utf-8") as f:
            m = _DIGEST_ACTION.search(f.read())
    except OSError:
        return ""
    action = m.group(1).strip() if m else ""
    return action if re.match(r"^https://\S+$", action) else ""


def digest_archive(action: str) -> str:
    """The newsletter's public web archive on Buttondown, worked out from the form's address
    (https://buttondown.com/api/emails/embed-subscribe/USERNAME -> https://buttondown.com/USERNAME/archive/),
    or "" when the address is not Buttondown's. js/core.js IS.digestArchive does the same for the
    dashboard. Buttondown's docs (docs.buttondown.com/email-archives) put the archive at
    buttondown.com/USERNAME; /archive/ is its list of past emails, newest first."""
    m = _BUTTONDOWN_FORM.match(action or "")
    return f"https://buttondown.com/{m.group(1)}/archive/" if m else ""


def signup_form(pitch: str, field: str | None = None, heading: str = "New internships in your inbox every Monday. Free.",
                what: bool = True, placement: str = "landing") -> str:
    """The weekly email's sign-up form, or "" while DIGEST_FORM is empty. Built like the dashboard's
    (js/app.js Digest): a plain form that posts straight from the browser to Buttondown, in a new tab
    (Buttondown may ask for a CAPTCHA or a fixed typo on its own page), so the address never reaches
    InternScout's servers. js/count.js counts a submit as "digest_signup", with nothing about who.
    `field`: the page's field tag, offered as one unticked box that sends it as a `tag`, the dashboard
    form's own field name and value (the tag key, not its label). Nothing is ticked for the student.
    `pitch`: the page's own sentence (with its number) ahead of what the email is. `heading`: /digest/
    has its own, since its h1 already says what the email is, and `what` False leaves out the sentence
    saying what the email holds, which /digest/ lists under the form instead."""
    if not DIGEST_FORM:
        return ""
    archive = digest_archive(DIGEST_FORM)
    box = ""
    if field:
        name = lower_name(field_title(field))
        box = (f'<label class="check"><input type="checkbox" name="tag" value="{esc(field)}"/> '
               f"Save {esc(name)} with my subscription, so the email can be matched to it later</label>")
    goes = "Your address and the field you tick go" if field else "Your address goes"
    about = ("One email on Mondays with the fields that gained the most new roles that week, a few postings "
             "from each and a link to the rest. For now everyone gets the same email.") if what else ""
    lead = " ".join(p for p in (pitch, about) if p)
    return (f'<form class="digest" action="{esc(DIGEST_FORM)}" method="post" target="_blank" rel="noopener" '
            f'aria-labelledby="digest-title" data-digest-placement="{esc(placement)}">'
            f'<h2 id="digest-title">{esc(heading)}</h2>'
            + (f"<p>{lead}</p>" if lead else "")
            + box +
            '<div class="digest-row"><label for="digest-email">Email</label>'
            '<input id="digest-email" type="email" name="email" required autocomplete="email" spellcheck="false"/>'
            '<button type="submit" class="cta">Email me new internships</button></div>'
            # In every one of Buttondown's sample forms; its docs don't say what it does, so it stays.
            '<input type="hidden" name="embed" value="1"/>'
            "<p class=\"fine\">Buttondown opens in a new tab to finish. You'll get a confirmation email first, and "
            f"nothing else arrives until you click its link. Unsubscribe any time. {goes} to Buttondown, which "
            "sends the email, not to InternScout's servers. <a href=\"/privacy#digest\">Details</a>"
            + (f' · <a href="{esc(archive)}" target="_blank" rel="noopener">Browse past emails</a>' if archive else "")
            + "</p></form>")


BEACON = ""   # set by build() from the site's own index.html
DIGEST_FORM = ""   # set by build(): the sign-up form's address (digest_form_action), "" while there is none
BASELINE: str | None = None   # set by build(): see baseline_day
# set by build(): when the data was exported. Everything a build writes is dated from it, never from
# the clock, so two builds of the same data are the same bytes (the 404 page and every feed's
# lastBuildDate differed on each deploy).
GENERATED: datetime | None = None
# set by build(): llms.txt and llms-full.txt (llms_files), which write() puts at the site's root.
TEXTS: dict[str, str] = {}
# set by build(): (term, path) of the soonest summer's "who's open now" page, or None (2026-10-07).
TRACKER: tuple[str, str] | None = None
# set by build(): the dashboard's crawlable "Browse" section (home_browse), which write() puts into the
# site's index.html between HOME_START and HOME_END (2026-10-07).
HOME = ""


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


def footer_browse() -> str:
    """The footer's links to the employer index and the soonest summer's tracker (2026-10-07): every
    page then links both, so a crawler reaches every employer page in two steps from any page."""
    links = ['<a href="/internships/at/">Employers hiring now</a>']
    if TRACKER:
        links.append(f'<a href="{TRACKER[1]}">{esc(TRACKER[0])}: who’s open now</a>')
    return " · ".join(links) + " · "


def page(path: str, title: str, description: str, h1: str, crumbs: list[tuple[str, str]],
         body: str, updated: str, index: bool = True, feed: bool = False, ld: tuple | list = (),
         thin: bool = False) -> str:
    """ld: more JSON-LD objects for the head (added 2026-10-02: the Organization, WebSite and
    FAQPage blocks of the hub and /about/), each in its own block after the breadcrumb trail.
    thin (2026-10-13, INDEX_COMBO): a real page kept out of search. It keeps its canonical link to
    itself and says "noindex, follow", so a crawler still follows its links to the indexed pages."""
    robots = (f'<link rel="canonical" href="{esc(SITE + path)}"/>\n<meta name="robots" content="noindex, follow"/>'
              if thin else f'<link rel="canonical" href="{esc(SITE + path)}"/>' if index
              else '<meta name="robots" content="noindex"/>')
    # was, in the head: the canonical link if index, else the noindex meta (no thin pages)
    url = SITE + path
    # One crumb is not a trail: no line at all, rather than a lone "› Internships" (2026-10-14, D24).
    # was: the line on every page, " › Internships" on the hub.
    crumb_html = ("<p class=\"crumbs\">" + " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1])
                  + f" › {esc(crumbs[-1][1])}</p>\n") if len(crumbs) > 1 else ""
    trail = {"@context": "https://schema.org", "@type": "BreadcrumbList",
             "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": t, "item": SITE + h}
                                 for i, (h, t) in enumerate(crumbs)]}
    # A breadcrumb trail of one is not a trail (Google reports it as invalid), so the hub has none.
    # (The escaping that was here is ld_script's, since 2026-10-02.)
    # Every page carries the Organization since 2026-10-05 (the audit: 2 of 297 did), once: a page
    # that passes it in `ld` (the hub, /about/, /pricing/) is not given a second copy.
    # was: ld_tag = "\n".join(([ld_script(trail)] if len(crumbs) > 1 else []) + [ld_script(o) for o in ld])
    objs = list(ld) + ([] if any(o.get("@id") == ORG_ID for o in ld) else [ORGANIZATION])
    ld_tag = "\n".join(([ld_script(trail)] if len(crumbs) > 1 else []) + [ld_script(o) for o in objs])
    # was: ld_tag = f'<script type="application/ld+json">{ld_json}</script>' if len(crumbs) > 1 else ""
    # The footer links /about/ and /compare/ from every page (2026-10-02), so crawlers and answer
    # engines reach the pages that say what InternScout is. was: only Privacy and Terms.
    # The header names what the install page offers and that it costs nothing (2026-10-04).
    # was: <a href="/install.html">Extension</a>
    # Pricing, Compare and About are in the nav since 2026-10-05 (the audit: the comparison page, the
    # site's best price story, was reachable only from the footer, and the prices had no page at all).
    # was: <nav><a href="/">Dashboard</a><a href="/internships/">Browse</a><a href="/install.html">Auto-Apply (free)</a></nav>
    # A landing visitor can find the optional digest before scrolling through the listings.
    # Reuse the existing nav link counter; the lower form keeps its landing placement.
    digest_nav = ('<a href="/digest/" data-digest-placement="nav">Free Monday email</a>'
                  if DIGEST_FORM and path.startswith("/internships/") else "")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}"/>
{robots}
<meta property="og:title" content="{esc(title)}"/>
<meta property="og:description" content="{esc(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{esc(url)}"/>
<meta property="og:image" content="{SITE}/og-preview.png"/>
<meta name="twitter:card" content="summary_large_image"/>
{f'<link rel="alternate" type="application/rss+xml" title="{esc(h1)} | InternScout" href="feed.xml"/>' if feed else ""}
<link rel="icon" type="image/png" sizes="48x48" href="/icon48.png"/>
<link rel="apple-touch-icon" href="/icon128.png"/>
<link rel="preload" href="/fonts/ibm-plex-sans-latin.woff2" as="font" type="font/woff2" crossorigin/>
<link rel="preload" href="/fonts/source-serif-4-latin.woff2" as="font" type="font/woff2" crossorigin/>
<style>{CSS}</style>
{ld_tag}
</head>
<body>
<div class="wrap">
<header><a class="mark" href="/">InternScout</a><nav><a href="/">Dashboard</a><a href="/internships/">Browse</a>{digest_nav}<a href="/install.html">Auto-Apply (free)</a><a href="/pricing/">Pricing</a><a href="/compare/">Compare</a><a href="/about/">About</a></nav></header>
<main>
{crumb_html}<h1>{esc(h1)}</h1>
{body}
<p class="updated">Updated {esc(updated)}. Listings are collected from public job boards several times a day; always check the posting on the employer's site before applying.</p>
</main>
<footer><strong>{SLOGAN}</strong> InternScout is a free internship search made by a UMass Amherst student. Not affiliated with UMass Amherst. {footer_browse()}<a href="/about/">About</a> · <a href="/pricing/">Pricing</a> · <a href="/compare/">Compare</a> · <a href="/employers/">For employers</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</div>
{BEACON}
{OFFER_TAG if OFFER_MARK in body else ""}
</body>
</html>
"""


def _dash_state(state: str) -> str:
    """The dashboard has state and province files, not metro or all-Canada ones: a metro opens its state
    or province, and Canada every province and the no-province file."""
    if state == "Canada":
        return ",".join(list(CA_PROVINCES) + ["Canada"])
    return ",".join(METRO_STATE.get(s, s) for s in state.split(","))    # was: CA_METRO_PAGES.get(s, s)


def dash_link(fields=(), state: str | None = None, companies=(), new: bool = False,
              stage: str | None = None, year: str | None = None, paid: bool = False) -> str:
    """The dashboard, opened on this page's fields, states, employer, new roles, stage, class year or
    paid roles (docs/js/app.js reads ?field=, ?state=a,b, ?company=, ?new=1, ?stage=, ?year= and
    ?paid=1; its canonical link keeps these one page to search engines). An employer goes as an exact
    name, not a search: searching "Intel" also finds "intelligence", and "Texas Instruments" reads as
    a place. A page with no state covers every state, so it sends state=all (the State picker's
    "Everywhere"; was: no state, and a saved profile's states then narrowed a nationwide page)."""
    q = [f"field={quote(','.join(fields), safe=',')}"] if fields else []
    q.append(f"state={quote(_dash_state(state), safe=',')}" if state else "state=all")
    q += [f"company={quote(c)}" for c in companies]
    if new:
        q.append("new=1")
    q += [f"{k}={quote(v)}" for k, v in (("stage", stage), ("year", year)) if v]
    if paid:
        q.append("paid=1")
    return "/?" + "&amp;".join(q)


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
                 src: str = "seo-field", faq: str = "", signup: str = "") -> str:
    more = len(items) - PER_PAGE
    order = "newest" if state else "newest, Northeast and remote first,"
    # `extra`: the employer pages' "at a glance" list, under the opening paragraph (2026-10-01).
    # `src`: which kind of page this is, for the install links' ?from= and the store's utm_source
    # (2026-10-04; see autoapply_card).
    # `faq`: the field, state and field-in-state pages' questions section (faq_section, 2026-10-05),
    # after the chart and before the follow lines; the employer pages carry theirs in `related`.
    return (f"<p class=\"lede\">{summary(items, what, where, tail, about)}</p>" + fits_line(fits or []) + extra +
            f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
            + autoapply_card(items, src, state)
            + f"<ul class=\"jobs\">{listing_rows(items, now, state, here, src)}</ul>"
            + (f"<p class=\"more\">Showing the {PER_PAGE} {order} of {len(items):,}. "
               f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>" if more > 0 else "")
            # `signup`: the weekly email's form (signup_form, 2026-10-06), on the field pages and
            # /internships/new/, straight after the list, where a reader has just seen what it would bring.
            + signup
            # The page's own numbers as a chart, under the list it summarises (2026-10-05, g_multimodal).
            + chart_figure(items, state)
            + faq
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
    # Workday's country-state-city form, "USA-Illinois-Chicago" or "USA-Arkansas-Ft. Smith", is
    # "Chicago, IL" (2026-10-07; it filled Mars's whole description).
    w = re.match(r"^(?:USA|US)-([A-Za-z .]+)-(.+)$", loc)
    if w and w.group(1).strip() in _STATE_NAMES:
        loc = f"{w.group(2).strip()}, {w.group(1).strip()}"
    w = re.match(r"^(?:USA|US)-([A-Z]{2})\s+(.+)$", loc)       # and "USA-IL Oak Brook" (Winland Foods)
    if w and w.group(1) in US_STATES:
        loc = f"{w.group(2).strip()}, {w.group(1)}"
    # 2026-10-13, found writing the employer descriptions: Bose's "US, MA - Framingham" (beside its own
    # "Framingham, MA", so one town counted as two), Gilead's "United States - California - Foster City",
    # Lyft's "Toronto, Canada" (a province code is on the region), Mars's "New York - 1166" (a site number).
    w = re.match(r"^(?:USA|US|United States)\s*,\s*([A-Z]{2})\s+-\s+(.+)$", loc)
    if w and w.group(1) in US_STATES:
        loc = f"{w.group(2).strip()}, {w.group(1)}"
    w = re.match(r"^(?:USA|US|United States)\s+-\s+([A-Za-z .]+?)\s+-\s+(.+)$", loc)
    if w and w.group(1).strip() in _STATE_NAMES:
        loc = f"{w.group(2).strip()}, {w.group(1).strip()}"
    w = re.match(r"^([^,]+),\s*Canada$", loc)
    if w and g.get("state") in CA_PROVINCES:
        loc = f"{w.group(1).strip()}, {g['state']}"
    loc = re.sub(r"\s+-\s+\d+$", "", loc)
    if loc.lower() in CITY_ALIASES and g.get("state") in US_STATES:       # Lyft's "SF"
        loc = f"{CITY_ALIASES[loc.lower()]}, {g['state']}"
    m = re.match(r"^(.*),\s*([A-Za-z .]+)$", loc)
    if m and m.group(2).strip() in _STATE_NAMES:
        loc = f"{m.group(1)}, {_STATE_NAMES[m.group(2).strip()]}"
    return loc


_COUNTRY = re.compile(r"[\s,-]*\b(United States( of America)?|USA|U\.S\.A?\.?|Canada|CAN)\s*$", re.I)
# A place that is only a country: true of the role, but no place to name in a one-line description.
_COUNTRY_ONLY = re.compile(r"^\s*(United States( of America)?|USA|US|U\.S\.A?\.?|Canada|CAN)\s*$", re.I)
# Short names boards use for a city the FAQ already names in full.
CITY_ALIASES = {"sf": "San Francisco", "nyc": "New York", "new york city": "New York"}


def city_name(g: dict, state: str) -> str:
    """A region's city as a state, province or metro page names it (2026-10-05): "Boston" for
    "Boston, MA", "Boston, MA USA" and "BOSTON, Massachusetts, United States", which place_name reads
    as three places; "Oakville" on the Toronto page for "Oakville, Ontario - Canada". The province
    stays on the Canada page ("Toronto, ON"). A loc that names only the country or the state is ""."""
    name = place_name(g)
    if name == "Remote":
        return name
    name = place_name({"loc": _COUNTRY.sub("", name).strip(" ,-")})     # "Oakville, Ontario" -> "Oakville, ON"
    code = METRO_STATE.get(state, state)          # was: CA_METRO_PAGES.get(state, state)
    if len(code) == 2:
        # "New York, NY" is the city: once the code is gone, the state's name is all that is left, and
        # it stays (2026-10-07; it was "", so the New York pages never named New York City).
        # was: for suffix in (...): name = re.sub(...)   (the name went too)
        bare = re.sub(rf"[\s,-]*\b{re.escape(code)}\s*$", "", name, flags=re.I).strip(" ,-")
        named = re.sub(rf"[\s,-]*\b{re.escape(US_STATES.get(code, code))}\s*$", "", bare, flags=re.I).strip(" ,-")
        name = bare if (not named and bare != name) else named
    elif state == "Canada" and name and "," not in name and g.get("state") in CA_PROVINCES:
        name = f"{name}, {g['state']}"            # "Toronto" beside "Toronto, ON" is one place
    # "MARKHAM" is a board shouting, "SF" is not.
    name = " ".join(w.title() if w.isalpha() and w.isupper() and len(w) > 3 else w for w in name.split())
    return CITY_ALIASES.get(name.lower(), name)


def places(items: list[dict], state: str | None = None) -> list[tuple[str, int]]:
    """Every place with open roles, most first; a role in three cities counts once in each. With
    `state`, only the places in it (a state, metro or "Canada", as place() reads them), by city_name:
    a Massachusetts page's "Where" answer would otherwise name New York for every role filed in both,
    and Boston three ways (2026-10-05)."""
    c: Counter = Counter()
    for x in items:
        regions = x.get("regions") or []
        if state:
            regions = [g for g in regions if g.get("state") == state or g.get("metro") == state
                       or (state == "Canada" and g.get("kind") == "canada")]
            names = {city_name(g, state) for g in regions}
        else:
            names = {place_name(g) for g in regions} or ({"Remote"} if x.get("is_remote") else set())
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


# ---------------------------------------------------------------- questions on the listing pages
# Added 2026-10-05. The employer pages have answered "when, where, does it pay" from their own roles
# since 2026-10-01; the field, state and field-in-state pages now answer the questions a student (or
# an assistant answering one) asks of them, in the same way: "how many software engineering internships
# are open", "which employers", "do they pay", "where". Every answer is counted from the page's own
# listings and dated from the data, and each page carries them twice: as a visible section at the end
# of the list, and as a FAQPage block (faq_ld) with the same plain text, so what an answer engine
# reads is what a reader sees. A question whose answer would be empty is left out.

FAQ_ANSWER_MAX = 300    # characters; an answer is quoted whole, so a long one is shortened (fewer names)
FAQ_NAMES = 5           # employers or places named in an answer, before shortening


def faq_ld(qa: list[tuple[str, str]]) -> dict:
    """The FAQPage block for (question, answer) pairs; the answers are plain text, as on the page."""
    return {"@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                           for q, a in qa]}


def faq_section(qa: list[tuple[str, str]]) -> str:
    return ("<section class=\"faq\">" + "".join(f"<h2>{esc(q)}</h2><p>{esc(a)}</p>" for q, a in qa)
            + "</section>") if qa else ""


def faq_topic(field: str | None, state: str | None, what: str = "internships") -> str:
    """The page's subject as a phrase: "software engineering internships in Massachusetts",
    "internships in Canada", "remote software engineering interns" (what="interns")."""
    lead = (lower_name(field_title(field)) + " ") if field else ""
    if state == "remote":
        return f"remote {lead}{what}"
    return f"{lead}{what}" + (f" {in_place(state)}" if state else "")      # was: f" in {US_STATES[state]}"


def _fit_names(make, names: list[str]) -> str:
    """make(names) with as many of the names as keep the answer within FAQ_ANSWER_MAX (one at least):
    five employers can be five "Executive Office for U.S. Attorneys and ..." long."""
    for k in range(len(names), 0, -1):
        a = make(names[:k])
        if len(a) <= FAQ_ANSWER_MAX:
            return a
    return a


def listing_faq(items: list[dict], field: str | None, state: str | None, updated: str) -> list[tuple[str, str]]:
    """(question, answer) for a field page (state None), a state, province, metro or Canada page
    (field None) or a field in one of them. Plain text; the HTML escaping is faq_section's."""
    n = len(items)
    if not n:
        return []
    topic = faq_topic(field, state)
    qa = []
    employers = len({employer_key(x["company_name"]) for x in items if x.get("company_name")})
    qa.append((f"How many {topic} are open right now?",
               f"{n:,} open {faq_topic(field, state, 'internships, co-ops and research roles')} as of {updated}, "
               f"from {plural(employers, 'employer')}."))
    names = top(Counter(x["company_name"] for x in items if x.get("company_name")), FAQ_NAMES)
    if names:
        roles = faq_topic(field, state, "roles")
        if employers == 1:
            a = f"All {plural(n, 'open role')} {'is' if n == 1 else 'are'} at {names[0]}."
        else:
            a = _fit_names(lambda ns: (f"The employers with the most open {roles} are {join_words(ns)}"
                                       + (f", of {employers:,} employers hiring." if employers > len(ns) else ".")), names)
        qa.append((f"Which employers are hiring {faq_topic(field, state, 'interns')}?", a))
    paid = sum(1 for x in items if is_paid(x))
    if paid:
        a = f"{paid:,} of the {n:,} open roles ({pct(paid, n)}) list pay or say they are paid."
        # The rates on a Canada page are Canadian dollars, and on every other page a role only in
        # Canada is left out of the range, as pay_report leaves it out of the medians.
        canada_page = state in CANADA_KEYS or state in CA_METRO_PAGES
        rates = hourly_range([x for x in items if canada_only(x) == canada_page])
        if rates:
            lo, hi, k = rates
            a += (f" The listed hourly rate is {money(lo)} an hour" if lo == hi else
                  f" Listed hourly rates run from {money(lo)} to {money(hi)} an hour")
            a += (", in Canadian dollars." if canada_page else
                  (", leaving out roles only in Canada." if any(canada_only(x) for x in items) else "."))
    else:
        a = f"None of the {n:,} open postings lists pay or says it is paid."
    qa.append((f"Do {topic} pay?", a))
    if state is None:
        # A field page spans the country: by state and province, as its chart is. A role in two counts in each.
        by_state = Counter(US_STATES[k] for x in items for k in x["keys"] if k in PLACES)
        remote = sum(1 for x in items if "remote" in x["keys"])
        where = sorted(by_state.items(), key=lambda kv: (-kv[1], kv[0]))
    elif state == "remote":
        where, remote = [], 0          # "Remote (500)" would be the whole answer
    else:
        where = [w for w in places(items, state) if w[0] != "Remote"]
        remote = sum(1 for x in items if x.get("is_remote") or "remote" in x["keys"])
    if where:
        # A field page counts states (and provinces), a state page places in it: "and 11 more states".
        unit = "more state" if state is None else "more place"
        a = _fit_names(lambda ws: f"The open roles are in {counted(where, len(ws)).replace('more place', unit)}.",
                       where[:FAQ_NAMES])
        if remote:
            a += f" {plural(remote, 'role')} can be done remotely."
        qa.append((f"Where are {topic}?", a))
    return qa


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
                "description": "A free internship search for college students in the US and Canada.",
                # The brand's own profiles. Mastodon links back here (docs/index.html: rel="me"); the
                # rest are InternScout's product accounts, made 2026-10-05 (the audit: sameAs had one
                # link). docs/index.html carries the same list; test_seo_pages.py checks they agree.
                # was: "sameAs": ["https://mastodon.social/@internscout"]
                "sameAs": ["https://mastodon.social/@internscout",
                           "https://www.instagram.com/internscout/",
                           "https://www.youtube.com/channel/UCnGXwtRhylBhkb8X6e_2uFg",
                           "https://www.facebook.com/profile.php?id=61595289743197",
                           "https://x.com/useinternscout",
                           "https://www.tiktok.com/@useinternscout",
                           "https://www.reddit.com/user/InternScout/"]}
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
# Each blurb says who the tier is for (D4.2, 2026-10-05 audit): Supporter's said only what it covered.
# Supporter is 50 runs a month with a .edu email (PLAN_MULTIPLIER), so "an application or two a day".
# was: "Supporter": "Covers the AI bill for a month of steady applying.",
PLAN_SHORT = {"Free": "Enough to try it on real applications.",
              "Supporter": "For a steady search: an application or two a day, AI bill covered.",
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
           "description": "A free internship search for college students, with a Chrome extension that "
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
            f'<div class="acts"><a class="go"{go_aa(x)} href="{esc(safe_url(x["apply_url"]))}" rel="nofollow noopener" '
            'target="_blank">Open posting</a></div>'
            "</li>")
    return "\n".join(rows)


def tablewrap(label: str) -> str:
    """The opening of the box a wide table scrolls sideways in. A keyboard can reach and scroll it, and a
    screen reader names it (2026-10-14, D24; was: a bare <div class="tablewrap">)."""
    return f"<div class=\"tablewrap\" tabindex=\"0\" role=\"region\" aria-label=\"{esc(label)}\">"


def table(head: list[str], rows: list[list[str]], num_from: int = 1, cls: str = "data", label: str = "Table") -> str:
    """An HTML table; cells are HTML already. Columns from num_from on hold figures and don't wrap.
    label: what the table is, for the scrolling box's name (tablewrap)."""
    th = "".join(f"<th scope=\"col\">{h}</th>" for h in head)
    body = "".join("<tr>" + "".join(f"<td class=\"num\">{c}</td>" if i >= num_from else
                                    (f"<th scope=\"row\">{c}</th>" if i == 0 else f"<td>{c}</td>")
                                    for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f"{tablewrap(label)}<table class=\"{cls}\"><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>"


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
                    + table(["Field", "Roles listing a rate", "Median", "Highest"], rows, label="Hourly pay by field") + "</section>")
    if rep["by_employer"]:
        rows = [[company_link(nm), f"{c:,}", esc(money(round(m, 2))), esc(rate_words(lo, hi).replace(" an hour", ""))]
                for nm, c, m, lo, hi in rep["by_employer"]]
        body.append("<section class=\"prose\"><h2>Top-paying employers</h2>"
                    f"<p>Employers with at least {MIN_PAY_EMPLOYER} open roles that list an hourly rate, by "
                    f"median rate: the top {len(rows)} of {rep['employers_listing']:,}.</p>"
                    + table(["Employer", "Roles listing a rate", "Median", "Range"], rows, label="Hourly pay by employer") + "</section>")
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
    # was: title = f"Highest-Paying Internships – Up to {money(hi0)} an Hour Listed | InternScout" (67 characters)
    title = [f"Highest-Paying Internships – Up to {money(hi0)} an Hour Listed",
             f"Highest-Paying Internships – Up to {money(hi0)} an Hour",
             f"Highest-Paying Internships – Up to {money(hi0)}/Hour", "Highest-Paying Internships"]
    desc = (f"The highest hourly pay listed on {len(rep['roles']):,} open internships, co-ops and research roles: "
            f"top roles, median pay by field and top-paying employers. Updated {long_day(now.isoformat())}.")
    return title, desc, "".join(body)


# ---- /about/

def about_answers(f: dict, majors: int, new: int, rep: dict | None, updated: str = "",
                  numbers: bool = False) -> list[tuple[str, str, str]]:
    """(question, answer, extra HTML) for /about/. The answer is plain text, the same words in the page
    and in its FAQPage block; the extra (a link) is the page's only. `numbers`: whether this build made
    /internships/by-the-numbers/, which the size answer then links (2026-10-05)."""
    top_fields = [lower_name(field_title(t)) for t in top(f["fields"], 5)]
    plans = " and ".join(f"{name} ({price} a month)" for name, price in PLAN_PRICES)
    qa = [
        ("What is InternScout?",
         f"InternScout is a free internship search for college students of every major in the US and "
         f"Canada. It lists {coverage_line(f)}, collected from employers’ own job boards several times a "
         f"day. {SLOGAN}", ""),
        # The headline figures, dated, in one answer (2026-10-05): what an assistant asked "how big is
        # InternScout" should find without adding up the others.
        ("How big is InternScout?",
         f"As of {updated}, {coverage_line(f)}, in {len(f['states'])} of the 50 US states and "
         f"{plural(len(f['provinces']), 'Canadian province or territory', 'Canadian provinces and territories')}. "
         f"{plural(new, 'of them was', 'of them were')} found in the last week.",
         f" <a href=\"{NUMBERS_PATH}\">InternScout by the numbers</a>." if numbers else ""),
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
    # The editorial disclosure the SEO audit asked for (a_author_diversity, 2026-10-05): how the pages
    # come to be and what part AI plays. It names nobody. classify.py is rule-based, and no AI model
    # runs anywhere in backend/internscout, so "no AI writes them" is checked, not claimed.
    qa.append(("How are InternScout's pages made?",
               "A script builds them. Several times a day it reads employers' own job boards, keeps the student "
               "roles and writes one page per field, state, major and employer. Every count and sentence on those "
               "pages comes from the listings themselves; no AI writes them. The code and the fixed text are "
               "written with AI assistance and reviewed by the student who runs InternScout before they go live. "
               "Each page is rebuilt from the latest listings on every update.", ""))
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
    faq = faq_ld([(q, a) for q, a, _ in qa])
    # was: the FAQPage object written out here; faq_ld since the listing pages carry one too (2026-10-05).
    body = (f"<p class=\"lede\">InternScout is a free internship search for college students of every major "
            f"in the US and Canada: {esc(coverage_line(f))}, as of {esc(updated)}.</p>"
            "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
            "<section class=\"faq\">" + "".join(f"<h2>{esc(q)}</h2><p>{esc(a)}{extra}</p>" for q, a, extra in qa)
            + "</section>"
            "<p class=\"more\">A plain-text summary for AI assistants: <a href=\"/llms.txt\">llms.txt</a> "
            "(and the longer <a href=\"/llms-full.txt\">llms-full.txt</a>).</p>")
    # was: "About InternScout – Free Internship Search for Every Major | InternScout" (72 characters), and a
    # description of "InternScout is a free internship search for college students of every major: ..." (175).
    return ("About InternScout – Free Internship Search",
            f"Free internship search for every major, no account needed: {coverage_line(f)}.",
            body, [ORGANIZATION, WEBSITE, faq])


# ---- /internships/by-the-numbers/
# Added 2026-10-05. The figures /about/, /compare/ and llms.txt each state in passing, on a page of
# their own: how many roles, employers, fields and places, how many are new, what the roles pay, which
# applicant tracking systems they come from, the largest fields and the states with the most roles.
# Each is a dated sentence an assistant can quote and a reader can check, counted from the same export
# as every listing page and rebuilt with them, so the numbers are never older than the listings. A
# Dataset block says the same in JSON-LD, dated from the data. Only made with MIN_KIND open roles or
# more: a statistics page about five listings would say nothing (and the test fixtures have five).

NUMBERS_PATH = "/internships/by-the-numbers/"
NUMBERS_TOP = 10        # fields, states and tracking systems named in each list


def numbers_page(f: dict, listings: list[dict], fields: dict, states: dict, rep: dict | None, new: int,
                 kind_made: list, now: datetime, updated: str) -> tuple[list, str, str, list]:
    """(title forms, description, body, JSON-LD) of /internships/by-the-numbers/."""
    n = f["open"]
    places_line = (f"{len(f['states'])} of the 50 US states and "
                   f"{plural(len(f['provinces']), 'Canadian province or territory', 'Canadian provinces and territories')}")
    rows = [("Open roles", f"{n:,}"), ("Employers", f"{f['employers']:,}"), ("Fields", f"{len(f['fields'])}"),
            ("Places", places_line), ("New this week", f"{new:,}"),
            ("List pay", f"{f['paid']:,} ({pct(f['paid'], n)})"),
            ("Give an hourly rate", f"{f['hourly']:,} ({pct(f['hourly'], n)})"),
            ("From applicant tracking systems", f"{f['from_boards']:,} ({pct(f['from_boards'], n)})")]
    facts = "<dl class=\"facts\">" + "".join(f"<dt>{esc(k)}</dt><dd>{esc(v)}</dd>" for k, v in rows) + "</dl>"

    # Open roles. The co-op and research counts are the kind pages' own (kinds), so they match those
    # pages and link to them; when neither page was made, nothing is said.
    roles = [f"On {esc(updated)} InternScout listed {esc(coverage_line(f))}.",
             f"They are in {esc(places_line)}; {plural(f['canada'], 'role is', 'roles are')} in Canada.",
             f"{plural(new, 'of them was', 'of them were')} found in the week to {esc(updated)}."]
    kinds_n = {k["slug"]: (path, len(items)) for path, k, items in kind_made}
    bits = []
    for slug, label in (("co-op", "co-ops"), ("research", "research positions")):
        if slug in kinds_n:
            path, k = kinds_n[slug]
            bits.append(f"<a href=\"{path}\">{k:,} {label}</a>")
    if bits:
        roles.append(f"Among them, as of {esc(updated)}: {join_words(bits)}.")

    pay = [f"{f['paid']:,} of the {n:,} open roles ({pct(f['paid'], n)}) list pay or say they are paid, as of {esc(updated)}.",
           f"{f['hourly']:,} ({pct(f['hourly'], n)}) give a clear hourly rate."]
    if rep:
        pay.append(f"Among the {len(rep['roles']):,} that give one and are not only in Canada (the same role on two "
                   f"boards counted once), the median is {esc(money(round(rep['median'], 2)))} an hour and the highest "
                   f"is {esc(money(rep['top'][0][2]))} an hour, as of {esc(updated)}.")
        pay.append(f"Roles only in Canada ({plural(rep['canada'], 'role')} with a rate) are left out of the median and "
                   "the top rate, since their pay is in Canadian dollars; yearly salaries and stipends are never "
                   "turned into hourly figures. <a href=\"/internships/highest-paying/\">Highest-paying internships</a> "
                   "has the roles, fields and employers.")

    # Where the listings come from: every tracking system ATS_NAMES knows, largest first.
    boards = sorted(f["boards"].items(), key=lambda kv: (-kv[1], kv[0]))
    ats = [f"{f['from_boards']:,} of the {n:,} open roles ({pct(f['from_boards'], n)}) come straight from employers' "
           f"own applicant tracking systems, as of {esc(updated)}; the other {n - f['from_boards']:,} are from "
           "employers' own careers sites and public lists."]
    if boards:
        name0, n0 = boards[0]
        ats.append(f"{esc(name0)} has the most, {n0:,} roles or {pct(n0, n)} of all open roles.")
        if len(boards) > 1:
            # pct rounds down, and "JazzHR 132 (0%)" reads as none.
            share = lambda k: pct(k, n) if k * 100 >= n else "under 1%"          # noqa: E731
            ats.append("Then " + esc(join_words([f"{nm} {k:,} ({share(k)})" for nm, k in boards[1:NUMBERS_TOP]])) + ".")

    def linked(path: str | None, name: str, k: int) -> str:
        return (f"<a href=\"{esc(path)}\">{esc(name)}</a>" if path else esc(name)) + f" ({k:,})"

    top_fields = sorted(f["fields"].items(), key=lambda kv: (-kv[1], kv[0]))[:NUMBERS_TOP]
    lead = (f"The {len(top_fields)} largest of the {len(f['fields'])} fields" if len(f["fields"]) > NUMBERS_TOP
            else f"{'Every field' if len(top_fields) > 1 else 'The one field'}")
    largest = [f"{lead}, by open roles on {esc(updated)}: "
               + join_words([linked(f"/internships/{field_slug(t)}/" if t in fields else None, field_title(t), k)
                             for t, k in top_fields]) + "."
               + (" A role tagged with two fields counts in each." if len(top_fields) > 1 else "")]
    by_state = Counter(k for x in listings for k in x["keys"] if k in PLACES and k not in CA_PROVINCES and k not in ("DC", "PR"))
    top_states = sorted(by_state.items(), key=lambda kv: (-kv[1], kv[0]))[:NUMBERS_TOP]
    remote = sum(1 for x in listings if "remote" in x["keys"])
    where = []
    if top_states:
        lead = (f"The {len(top_states)} US states with the most open roles" if len(by_state) > NUMBERS_TOP
                else f"Open roles by US state")
        where.append(f"{lead} on {esc(updated)}: "
                     + join_words([linked(f"/internships/{state_slug(k)}/" if k in states else None, US_STATES[k], c)
                                   for k, c in top_states]) + "."
                     + (" A role filed in two states counts in each." if len(top_states) > 1 else ""))
    if remote:
        where.append(f"{plural(remote, 'open role')} can be done remotely.")
    provinces = sorted(((k, c) for k, c in Counter(k for x in listings for k in x["keys"] if k in CA_PROVINCES).items()),
                       key=lambda kv: (-kv[1], kv[0]))[:3]
    if provinces:
        where.append(f"In Canada, {'the most are' if len(provinces) > 1 else 'they are'} in {join_words([linked(f'/internships/{state_slug(k)}/' if k in states else None, US_STATES[k], c) for k, c in provinces])}.")

    def section(title: str, sentences: list[str]) -> str:
        return f"<h2>{esc(title)}</h2><p>{' '.join(sentences)}</p>"

    body = (f"<p class=\"lede\">As of {esc(updated)}, InternScout lists {esc(coverage_line(f))}. Every figure on this "
            "page is counted from the open listings on that day, and the page is rebuilt with every update.</p>"
            + facts + "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
            + "<section class=\"prose\">" + section("Open roles", roles) + section("Pay", pay)
            + section("Where the listings come from", ats) + section("The largest fields", largest)
            + (section("Where the roles are", where) if where else "")
            + section("How this is counted", [
                f"Every figure is counted from the listings open on {esc(updated)}, the same export the listing pages "
                "are built from. Spellings of one employer count as one employer. Pay is what the posting says, and a "
                "role that lists none is counted as listing none. A dated figure is true of that day; the page is "
                "rebuilt, and the date moves, with every update."])
            + "</section>")
    desc = (f"InternScout on {updated}: {n:,} open internships, co-ops and research roles from "
            f"{plural(f['employers'], 'employer')} in {plural(len(f['fields']), 'field')}. What they pay, and which "
            "job boards they come from.")
    measured = [("Open roles", n), ("Employers", f["employers"]), ("Fields", len(f["fields"])),
                ("US states with open roles", len(f["states"])), ("Canadian provinces and territories with open roles", len(f["provinces"])),
                ("Roles in Canada", f["canada"]), ("Roles found in the last week", new),
                ("Roles that list pay or say they are paid", f["paid"]), ("Roles that give an hourly rate", f["hourly"]),
                ("Roles from employers' applicant tracking systems", f["from_boards"])]
    if rep:
        measured += [("Median listed hourly rate, USD, roles not only in Canada", round(rep["median"], 2)),
                     ("Highest listed hourly rate, USD, roles not only in Canada", rep["top"][0][2])]
    ld = {"@context": "https://schema.org", "@type": "Dataset", "@id": SITE + NUMBERS_PATH,
          "name": "InternScout by the numbers", "url": SITE + NUMBERS_PATH, "description": desc,
          "dateModified": f"{now:%Y-%m-%d}", "temporalCoverage": f"{now:%Y-%m-%d}",
          "creator": {"@id": ORG_ID}, "publisher": {"@id": ORG_ID}, "isAccessibleForFree": True,
          "variableMeasured": [{"@type": "PropertyValue", "name": k, "value": v} for k, v in measured]}
    return [f"InternScout by the Numbers – {n:,} Open Roles", "InternScout by the Numbers"], desc, body, [ld]


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
        "every career level. InternScout lists only internships, co-ops and research roles for college "
        f"students: {f['open']:,} open today, from {plural(f['employers'], 'employer')} in "
        f"{plural(len(f['fields']), 'field')}.</p>"
        # was: "... cover every career level; InternScout lists only ..." in one sentence of 35 words (the
        # audit of 2026-10-05 measured the lede's sentences at over 25 words).
        + table(["<span class=\"vh\">Feature</span>", "InternScout", "Simplify", "Jobright"], rows, num_from=99,
                cls="data cmp", label="InternScout, Simplify and Jobright compared")
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
    # was: "InternScout vs Simplify vs Jobright – Price and Features Compared | InternScout" (79 characters),
    # and "... and who submits applications. Sources dated {COMPARE_AS_OF}." (171).
    return ("InternScout vs Simplify vs Jobright – Prices",
            "InternScout, Simplify and Jobright compared: who each is for, free tiers, paid plans ($4–$8 vs "
            f"$39.99 a month) and who submits. Sources as of {COMPARE_AS_OF}.", body)


# ---- /pricing/
# Added 2026-10-05 after the site audit: the prices lived only in the dashboard's dismissible plans notice
# and the /about/ FAQ, with no page of their own, no link in the nav, no tier picked out, and the
# $4-against-$39.99 comparison far from any price. Every number here comes from the same constants as
# /about/ and /compare/ (FREE_EDU, PLAN_PRICES, PLAN_MULTIPLIER), which mirror worker/src/config.js.

def tier_card(name: str, price: str) -> str:
    """One plan as a card: name, price, what it is for, what it gives, and where to get it."""
    edu, other = plan_allowance(name)
    pick = name == RECOMMENDED_PLAN
    # Only the picked tier's button is solid; the others are secondary (2026-10-14, D23). was: "cta" on all three.
    btn = "cta" if pick else "cta secondary"
    lines = [f"{edu['autofill']} Auto-Apply runs and {edu['resume_tailor']} tailored resumes a month with a school .edu email",
             f"{other['autofill']} runs and {other['resume_tailor']} resumes with any other email"]
    if name == "Free":
        lines = ["Search, ranking and browsing every listing, with no account"] + lines
        cta = f"<a class=\"{btn}\" href=\"/\">Search free</a>"
    else:
        lines = ["Everything in Free"] + lines + ["Cancel any time; the plan runs to the end of the month you paid for"]
        # The dashboard reads ?upgrade= and offers that plan's checkout (docs/js/app.js), after sign-in.
        cta = f"<a class=\"{btn}\" href=\"/?upgrade={name.lower()}\">Get {esc(name)}</a>"
    return (f"<section class=\"tier{' pick' if pick else ''}\" id=\"{name.lower()}\">"
            # "Recommended" (2026-10-14, D23): there is no sales data behind "Most popular", the badge's old words.
            + ("<span class=\"badge\">Recommended</span>" if pick else "")
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
    # was: "InternScout Pricing – Free Search, Auto-Apply Plans from " + low + " a Month | InternScout" (81 characters)
    return ("InternScout Pricing – Free, Upgrades from " + low,
            f"Free to search, no account. The Auto-Apply extension has a free monthly allowance; {plans} a month "
            "raise it. Simplify+ and Jobright Turbo are $39.99.",
            body, [ORGANIZATION, PRODUCT])


def digest_examples(new: list[dict]) -> str:
    """Three real new roles from this export, favoring different fields and employers.

    A sample is not a promise that a listing stays open or appears in next Monday's email.
    Filtering here also keeps this safe when called outside build() with untrusted rows.
    """
    pool = newest_first([x for x in unique_roles(new)
                         if x.get("status") == "open" and safe_url(x.get("apply_url"))])
    picked, fields, employers = [], set(), set()
    while pool and len(picked) < 3:
        best = max(range(len(pool)), key=lambda i: (
            bool(set(pool[i].get("field_tags") or []) - fields),
            employer_key(pool[i].get("company_name") or "") not in employers))
        x = pool.pop(best)
        picked.append(x)
        fields.update(x.get("field_tags") or [])
        employers.add(employer_key(x.get("company_name") or ""))
    if not picked:
        return ""
    dated = f" Snapshot: {GENERATED.strftime('%B %d, %Y')}." if GENERATED else ""
    rows = "".join(
        f'<li><a href="{esc(safe_url(x["apply_url"]))}" target="_blank" rel="nofollow noopener">'
        f'{esc(x.get("title") or "View posting")}</a> at {esc(x.get("company_name") or "Employer")} '
        f'<span class="meta">({esc(place(x))})</span></li>' for x in picked)
    return ('<section class="prose digest-examples" aria-labelledby="digest-examples-title">'
            '<h2 id="digest-examples-title">Examples from this week</h2>'
            f'<p>Examples from roles found this week.{dated} Availability can change; check the employer’s posting.</p>'
            f'<ul class="plain">{rows}</ul></section>')


def digest_page(new: list[dict], by_field: Counter, new_page: bool) -> tuple[str, str, str]:
    """(title, description, body) of /digest/, the weekly email's page (2026-10-06). `new` is this
    week's new roles as the email counts them (new_roles) and `by_field` the same per field; new_page
    says whether /internships/new/ was made. With no form address yet (DIGEST_FORM empty) the page has
    no form and says sign-ups aren't open, and build() keeps it out of search and the sitemap."""
    top3 = [t for t, k in sorted(by_field.items(), key=lambda tk: (-tk[1], field_title(tk[0])))
            if k >= DIGEST_MIN_NEW][:3]
    count = (f"{len(new):,} new internships in the last week"
             + (f", the most in {esc(join_words([lower_name(field_title(t)) for t in top3]))}." if top3 else ".")
             if len(new) >= DIGEST_MIN_NEW else "")
    lede = (f"<p class=\"lede\">{count + ' ' if count else ''}One free email every Monday with the internships, "
            "co-ops and research roles InternScout found that week.</p>")
    if DIGEST_FORM:
        body = (lede + signup_form("A selection of new roles, with links to explore the rest. Everyone gets the same email for now.",
                                   heading="Get the free weekly email", what=False, placement="digest-page")
                + digest_examples(new)
                + "<section class=\"prose\"><h2>What you get</h2><ul class=\"plain\">"
                "<li>One email on Mondays. It lists the fields that gained the most new roles that week, a few "
                "postings from each, Northeast and remote first, and a link to the rest of each field.</li>"
                "<li>For now everyone gets the same email.</li>"
                "<li>A confirmation email comes first, and nothing else arrives until you click its link. Every "
                "email has an unsubscribe link at the bottom.</li>"
                "<li>Buttondown sends the email and keeps your address; InternScout's servers never see it. Open "
                "and click tracking are off. <a href=\"/privacy#digest\">How the list is handled</a>.</li>"
                "</ul></section>")
    else:
        where = ("<a href=\"/internships/new/\">New this week</a> lists every role found in the last week, and "
                 "its RSS feed can follow it in a feed reader or a Discord or Slack channel."
                 if new_page else "<a href=\"/internships/\">Browse open internships</a> by field, state or major.")
        body = lede + f"<p>Sign-ups for the email aren't open yet. Until they are, {where}</p>"
    return ("New internships in your inbox every Monday. Free.",
            "One free email every Monday with the new internships, co-ops and research roles InternScout found "
            "that week. Confirm once, unsubscribe any time.",
            body)


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
        # was: "Every listing links to ..." (a few link to a job site instead: own_posting). 2026-10-13
        "- Updated several times a day. Almost every listing links to the employer's own posting.",
        "- Not affiliated with UMass Amherst, or with any employer it lists.",
    ]
    main_pages = [link("/", "Dashboard", "search every open listing and rank it for your major, class year and states"),
                  link("/about/", "About InternScout", "what it is, what is free, where listings come from, in direct answers"),
                  link("/pricing/", "Plans and prices", f"free search; the Auto-Apply extension's free allowance and the {plans} plans"),
                  link("/compare/", "InternScout vs Simplify vs Jobright", "prices and features compared, with dated sources")]
    if "/internships/highest-paying/" in made:
        main_pages.append(link("/internships/highest-paying/", "Highest-paying internships",
                               "top listed hourly pay by role, field and employer, rebuilt every update"))
    if NUMBERS_PATH in made:
        main_pages.append(link(NUMBERS_PATH, "InternScout by the numbers",
                               "open roles, employers, fields, states, pay and job-board shares, each a dated sentence"))
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


# ---------------------------------------------------------------- <field> internships near <city> (2026-10-18)
# Ten NCES degree-field groups (top_degree_fields.json) in each of the 50 largest US metros
# (us_top50_metros.json): 500 pages at /internships/near/<city>/<field>/, and a hub at /internships/near/
# linking every one. near_metros decides which listings are local to a metro (towns per state, New York's
# 50-mile radius, never a statewide or remote role) and which tags make up each field group.
# Every one of the 500 URLs is built on every deploy, with whatever is open, so a link to one never breaks.
# But 500 pages from one template are what search engines treat as doorway pages, so one is indexed only
# when it is a real list of its own (near_indexed): NEAR_INDEX_MIN local roles at least, from
# MIN_EMPLOYERS_NEW employers, and not near_same as a page the site already indexes. The rest are
# "noindex, follow" and out of the sitemap (page(thin=True)), like a thin field-in-a-place page.
NEAR_ROOT = "/internships/near/"
# Off only in tests (backend/tests/conftest.py), except the near-page tests themselves: the 500 pages
# made every test build about ten times slower. Production always builds them.
NEAR_ON = True
NEAR_INDEX_MIN = 5      # local open roles a near page needs before search engines are asked to index it
NEAR_INDEX_SLACK = 1    # ...and one already in the live sitemap stays indexed down to NEAR_INDEX_MIN - this
NEAR_REMOTE_SHOWN = 10  # remote roles listed on a page that is not indexed (an indexed one gives a count)


def near_path(m: dict, slug: str) -> str:
    return f"{NEAR_ROOT}{near_metros.metro_slug(m)}/{slug}/"


def near_indexed(local: list[dict], path: str, live, earning: frozenset, rivals: list[frozenset]) -> bool:
    """Whether a near page is asked into search (NEAR_INDEX_MIN). A page people already find in search
    (earning) stays in whatever its count."""
    if path in earning:
        return True
    need = NEAR_INDEX_MIN - (NEAR_INDEX_SLACK if path in live else 0)
    employers = {employer_key(x["company_name"]) for x in local if x.get("company_name")}
    if len(local) < need or len(employers) < MIN_EMPLOYERS_NEW:
        return False
    mine = frozenset(x["id"] for x in local)
    # Only lists of about the same size can be near_same (the shared roles are NEAR_SAME of all of either).
    return not any(NEAR_SAME * max(len(r), len(mine)) <= min(len(r), len(mine)) and near_same(mine, r)
                   for r in rivals)


def near_local(listings: list[dict]) -> dict[str, list[tuple[dict, list[dict]]]]:
    """CBSA -> [(listing, its regions inside that metro)], each listing once per metro, in listing order."""
    out: dict[str, list] = {}
    for x in listings:
        inside: dict[str, list] = {}
        for g in x.get("regions") or []:
            for cbsa in sorted(near_metros.region_metros(g)):
                inside.setdefault(cbsa, []).append(g)
        for cbsa, regs in sorted(inside.items()):
            out.setdefault(cbsa, []).append((x, regs))
    return out


def near_town(g: dict, cbsa: str) -> str:
    """The town a local region is in, as the page names it: the region's own city name when that is the
    town ("McKinney"), else the town it matched ("Denver" for "Hybrid - Denver, CO")."""
    name = city_name(g, g.get("state") or "")
    town = near_metros.region_town(g, cbsa)
    if not town or near_metros.place_key(name) == town:
        return name
    if town in near_metros.TOWN_NAMES:
        return near_metros.TOWN_NAMES[town]
    return " ".join(w if w in ("of", "and") else w[:1].upper() + w[1:] for w in town.split())


def near_view(x: dict, regs: list[dict]) -> dict:
    """The listing with its regions in this metro first, so its row names the local one (place())."""
    rest = [g for g in x.get("regions") or [] if not any(g is r for r in regs)]
    return dict(x, regions=list(regs) + rest)


def near_how(m: dict, f: dict) -> str:
    """What the page counts, in plain words: the metro as drawn, and the tags that make up the field."""
    cbsa = m["cbsa"]
    where = (near_metros.RADIUS_WORDS[cbsa] if cbsa in near_metros.RADIUS_WORDS
             else f"in the {m['name']} metro area, matched by town name")
    tags = [field_title(t) for t in near_metros.FIELD_TAGS[f["slug"]]]
    return (f"Counted here: roles with a location {where}. Roles that only name a state, and remote roles, "
            f"are not counted as local. {f['name']} here means the roles InternScout tags {join_words(tags)}.")


def near_title(f: dict, m: dict, local: list[dict]) -> Head:
    """ "Business Internships near Denver: 75+ Open | InternScout". The count floor (or, under 10 roles, the
    start term most of them share) is the page's own; the field's short name when the full one won't fit."""
    floor, term = count_floor(len(local)), main_term(local)
    subjects = [f"{name} Internships near {m['city']}"
                for name in dict.fromkeys([f["name"], near_metros.FIELD_SHORT.get(f["slug"], f["name"])])]
    tails = [f": {floor} Open"] if floor else [f", {term}"] if term else []
    # The page's own figure outranks the field's full name and the brand, in that order.
    forms = ([s + t + TITLE_SUFFIX for s in subjects for t in tails] + [s + t for s in subjects for t in tails]
             + [s + TITLE_SUFFIX for s in subjects] + subjects)
    return Head(next((c for c in forms if len(c) <= TITLE_MAX), fit_title(subjects[-1])))


def near_description(f: dict, m: dict, local: list[dict], remote: int, updated: str) -> str:
    what, label = f"{lower_name(f['name'])} internships", near_metros.metro_label(m)
    if local:
        return listing_description(len(local), what, f"near {label}", local, updated)
    # Long enough as it is that fit_description adds nothing about roles this page does not have.
    more = f", and {remote:,} remote ones" if remote else ""
    return (f"No open {what} near {label} right now. This page links {lower_name(f['name'])} roles near other "
            f"US cities{more}. Updated {updated}.")


def near_body(f: dict, m: dict, local: list[tuple[dict, list[dict]]], remote: list[dict], now: datetime,
              path: str, indexed: bool, related: str) -> str:
    label, lname = near_metros.metro_label(m), lower_name(f["name"])
    key = "near:" + m["cbsa"]            # no region is filed under this, so place() leads with regions[0]
    items = [near_view(x, regs) for x, regs in local]
    tags = list(near_metros.FIELD_TAGS[f["slug"]])
    # The dashboard reads at most six fields (docs/js/core.js filtersFromUrl): the six with the most roles here.
    by_tag = Counter(t for x, _ in local for t in x.get("field_tags") or [] if t in tags)
    dash_tags = sorted(tags, key=lambda t: (-by_tag[t], tags.index(t)))[:6]
    # The dashboard filters by state, not by town, so the link says so.
    states = near_metros.metro_states(m["cbsa"])
    dash = dash_link(dash_tags, ",".join(states))
    out = []
    if items:
        towns = Counter(n for _, regs in local for n in {near_town(g, m["cbsa"]) for g in regs} if n)
        where = sorted(towns.items(), key=lambda kv: (-kv[1], kv[0]))
        lead = summary(items, f"in {lname}", f" near {label}", tail="")
        if len(where) > 1:
            lead += " " + esc(f"By town: {counted(where, 3)}.")
        out.append(f"<p class=\"lede\">{lead}</p>")
    else:
        out.append(f"<p class=\"lede\">{esc(f'InternScout has no open {lname} roles with a location near {label} right now.')} "
                   "Listings are collected from public job boards several times a day, so this page changes as "
                   "employers post.</p>")
    out.append(f"<p class=\"fits\">{esc(near_how(m, f))}</p>")
    cta = f"Search {lname} roles in {join_words([US_STATES[k] for k in states])} on the dashboard"
    out.append(f"<a class=\"cta\" href=\"{dash}\">{esc(cta)}</a>")
    if items:
        out.append(autoapply_card(items, "seo-near", key))
        out.append(f"<ul class=\"jobs\">{listing_rows(items, now, key, path, 'seo-near')}</ul>")
        if len(items) > PER_PAGE:
            out.append(f"<p class=\"more\">Showing the {PER_PAGE} newest of {len(items):,}. "
                       f"<a href=\"{dash}\">See every one on the dashboard</a>.</p>")
        out.append(chart_figure(items, key))
    # Remote roles, apart and labelled: open to a student in this city, but not in it.
    if remote:
        words = (f"{plural(len(remote), 'remote ' + lname + ' role')} {'is' if len(remote) == 1 else 'are'} open "
                 "to students anywhere in the US. They are not counted above.")
    else:
        words = f"No remote {lname} roles are open right now."
    section = (f"<section class=\"rel\"><h2>{esc('Remote ' + lname + ' roles')}</h2><p class=\"more\">{esc(words)}"
               + (f" <a href=\"{dash_link(dash_tags, 'remote')}\">See them on the dashboard</a>." if remote else "")
               + "</p>")
    if remote and not indexed:
        section += f"<ul class=\"jobs\">{listing_rows(remote[:NEAR_REMOTE_SHOWN], now, 'remote', path, 'seo-near')}</ul>"
    out.append(section + "</section>")
    if items:
        out.append("<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
                   "<a href=\"feed.xml\">RSS feed</a></p>")
    out.append(related + f"<p class=\"more\"><a href=\"{NEAR_ROOT}\">Every field near all 50 cities</a></p>")
    return "".join(out)


def near_pages(listings: list[dict], now: datetime, updated: str, live, earning: frozenset,
               rivals: list[frozenset]) -> tuple[list[dict], dict]:
    """The 500 pages as add() arguments, and (path, field, local roles) per (CBSA, field slug) for the hub."""
    local_by_metro = near_local(listings)
    remote_all = newest_first([x for x in listings if near_metros.us_remote(x)])

    def tagged(slug: str, x: dict) -> bool:
        return bool(set(near_metros.FIELD_TAGS[slug]) & set(x.get("field_tags") or []))

    grid = {(m["cbsa"], f["slug"]): [(x, regs) for x, regs in local_by_metro.get(m["cbsa"], []) if tagged(f["slug"], x)]
            for m in near_metros.METROS for f in near_metros.FIELDS}
    remote_by_field = {f["slug"]: [x for x in remote_all if tagged(f["slug"], x)] for f in near_metros.FIELDS}
    hub = {(m["cbsa"], f["slug"]): (near_path(m, f["slug"]), f["name"], len(grid[(m["cbsa"], f["slug"])]))
           for m in near_metros.METROS for f in near_metros.FIELDS}
    specs = []
    for m in near_metros.METROS:
        label = near_metros.metro_label(m)
        for f in near_metros.FIELDS:
            local = grid[(m["cbsa"], f["slug"])]
            path = near_path(m, f["slug"])
            ids = {x["id"] for x, _ in local}
            remote = [x for x in remote_by_field[f["slug"]] if x["id"] not in ids]
            items = [near_view(x, regs) for x, regs in local]
            indexed = near_indexed(items, path, live, earning, rivals)
            # The city's other fields and the field's other cities, most roles first (then by name).
            fields_here = sorted((hub[(m["cbsa"], ff["slug"])] for ff in near_metros.FIELDS if ff["slug"] != f["slug"]),
                                 key=lambda e: (-e[2], e[1]))
            cities = sorted(((hub[(mm["cbsa"], f["slug"])][0], near_metros.metro_label(mm), hub[(mm["cbsa"], f["slug"])][2])
                             for mm in near_metros.METROS if mm["cbsa"] != m["cbsa"]), key=lambda e: (-e[2], e[1]))
            related = (link_list(f"Other fields near {m['city']}", fields_here)
                       + link_list(f"{f['name']} internships near other cities", cities))
            specs.append({
                "path": path, "title": near_title(f, m, items),
                "desc": near_description(f, m, items, len(remote), updated),
                "h1": f"{f['name']} internships near {label}",
                "crumbs": [("/internships/", "Internships"), (NEAR_ROOT, "Near 50 US cities"),
                           (path, f"{f['name']} near {m['city']}")],
                "body": near_body(f, m, local, remote, now, path, indexed, related),
                "items": items or None, "state": "near:" + m["cbsa"], "thin": not indexed, "kind": "near"})
    return specs, hub


def near_hub(hub: dict) -> tuple[list[str], str, str]:
    """(title forms, description, body) of /internships/near/: every one of the 500 pages, by city."""
    sections = [link_list(f"Near {near_metros.metro_label(m)}", [hub[(m["cbsa"], f["slug"])] for f in near_metros.FIELDS])
                for m in near_metros.METROS]
    body = ("<p class=\"lede\">Internships in ten of the largest college degree fields, near each of the 50 largest "
            "US metro areas. The fields are the ten largest by bachelor's degrees awarded in 2021-22 (NCES Digest "
            "2023, Table 322.10). The metro areas are the 50 largest by population (Census estimates for July 2025). "
            "Each number is how many open roles have a location in that metro area now. A role in two cities "
            "counts in both. Remote roles are listed apart on each page.</p>"
            + "".join(sections))
    title = ["Internships by Field Near 50 US Cities", "Internships Near 50 US Cities"]
    desc = ("Internships in the ten largest college degree fields near the 50 largest US metro areas, counted by "
            "city and field from open listings. Remote roles listed apart. Free, no sign-up.")
    return title, desc, body


# ---------------------------------------------------------------- build

def build(site_dir: str, live: dict[str, str] | set[str] | frozenset[str] = frozenset(),
          held: set[str] | frozenset[str] = frozenset(), earning: frozenset[str] | None = None) -> list[dict]:
    """live: the pages the site is serving now (live_paths), which get the lower keep_at bar and
    whose lastmod the new one never goes below. held: the noindex pages it is serving now
    (held_paths), live for keep_at though not in the sitemap. earning: the pages people find in
    search (earning_paths, read from SEARCH_PAGES when None), which are never made noindex."""
    global BEACON, BASELINE, GENERATED, DIGEST_FORM
    earning = earning_paths() if earning is None else earning
    # Served now, indexed or not: what keep_at and fold_at ask. was: path in live (no noindex pages).
    served = set(live) | set(held)
    BEACON = beacon_from(site_dir)
    DIGEST_FORM = digest_form_action(site_dir)
    d = load(site_dir)
    BASELINE = d["baseline"]
    listings = d["listings"]
    LISTINGS[:] = listings          # for main(): placements resolve against these (2026-10-14)
    now = _when(d["generated_at"]) or datetime.now(timezone.utc)
    GENERATED = now
    # The weekly email's numbers for the sign-up forms (2026-10-06): this week's new roles counted as the
    # email counts them (new_roles), in all and per field, so a page never quotes a number the email
    # wouldn't. A field's is quoted only when it reaches DIGEST_MIN_NEW, the email's bar for a section.
    digest_new = new_roles(d, now)
    digest_by_field = Counter(t for x in digest_new for t in set(x.get("field_tags") or []) - SKIP_FIELDS)
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
        return n >= need or (path in served and n >= keep_at(need))      # was: path in live

    fields = {t: v for t, v in by_field.items() if enough(len(v), f"/internships/{field_slug(t)}/")}
    states = {k: v for k, v in by_state.items() if enough(len(v), f"/internships/{state_slug(k)}/")}
    def ids(items: list[dict]) -> frozenset:
        return frozenset(x["id"] for x in items)

    def fold_at(path: str) -> float:
        return SAME_SHARE if path in served else NEAR_SAME              # was: path in live

    def employers_in(items: list[dict]) -> int:
        return len({employer_key(x["company_name"]) for x in items if x.get("company_name")})

    # A US metro gets a page only when it is its own list (2026-10-07): enough employers, and not most
    # of its state's page under a second name.
    for m in sorted(US_METRO_PAGES):
        path, parent = f"/internships/{state_slug(m)}/", by_state.get(METRO_STATE[m], [])
        if m in states and (employers_in(states[m]) < MIN_EMPLOYERS_NEW
                            or near_same(ids(states[m]), ids(parent), fold_at(path))):
            del states[m]
    # Which summers get a "who's open now" page (2026-10-07): the ones still ahead whose term page is made
    # (MIN_KIND roles, as kinds()), with MIN_OPEN employers or more. Decided before any page is drawn,
    # since every page's footer links the soonest one (TRACKER).
    global TRACKER
    by_term = {}
    for x in listings:
        by_term.setdefault(x.get("term"), []).append(x)
    trackers = [t for t in upcoming_summers(by_term, now)
                if enough(len(by_term[t]), f"/internships/{slugify(t)}/", MIN_KIND)
                and enough(employers_in(by_term[t]), tracker_path(t), MIN_OPEN)]
    TRACKER = (trackers[0], tracker_path(trackers[0])) if trackers else None
    # A field slug and a state slug must never name the same folder.
    state_slugs = {state_slug(k) for k in states}
    fields = {t: v for t, v in fields.items() if field_slug(t) not in state_slugs}

    combos: dict[tuple[str, str], list] = {}
    widen = []                                        # the 2026-10-07 rules' candidates, made after
    for t, items in sorted(fields.items()):         # was: for t, items in fields.items():
        for k in sorted(states):                      # was: for k in states:
            hit = [x for x in items if k in x["keys"]]
            local = [x for x in hit if len(x["keys"] & PLACES) < SPREAD]
            path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
            if k not in US_METRO_PAGES and enough(len(local), path, MIN_COMBO):
                combos[(t, k)] = hit
                continue
            priority = t in PRIORITY_FIELDS and (k in PRIORITY_PLACES or k in US_METRO_PAGES)
            if ((k in US_METRO_PAGES or priority) and hit
                    and enough(len(local), path, MIN_COMBO_PRIORITY if priority else MIN_COMBO)):
                widen.append((t, k, hit, path))
    # The widened pages, biggest first (then by name, so every build agrees), each kept only when it is
    # its own list: MIN_EMPLOYERS_NEW employers, and not near_same as the field's page, the field in the
    # metro's state, or a page already made for another field in the same place ("engineering" and
    # "mechanical" in Houston can be one list). Biggest first, so of two such pages the fuller one stays.
    for t, k, hit, path in sorted(widen, key=lambda w: (-len(w[2]), w[0], w[1])):
        mine = ids(hit)
        rivals = [ids(fields[t])] + [ids(v) for (tt, kk), v in sorted(combos.items())
                                     if kk == k or (tt == t and kk == METRO_STATE.get(k))]
        if employers_in(hit) >= MIN_EMPLOYERS_NEW and not any(near_same(mine, r, fold_at(path)) for r in rivals):
            combos[(t, k)] = hit
    combos = dict(sorted(combos.items()))

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
        # was: if (not slugify(name) or ...   (real_company since 2026-10-07)
        if (not slugify(name) or not real_company(name) or path in EMPLOYERS.values() or student_share(items) < 0.5
                or not enough(len(items), path, MIN_EMPLOYER)):
            continue
        by_company[name], spellings[name] = items, sorted(names)
        EMPLOYERS.update({n: path for n in names})

    # index (2026-10-06): False makes the page noindex and keeps it out of the sitemap (/digest/ until
    # the sign-up form has an address). was: every page was indexed.
    # dated (2026-10-07): the listings a page without a list of its own is about (a tracker's term), which
    # date it and make it a CollectionPage like a listing page, without a feed.
    # thin (2026-10-13, INDEX_COMBO): built and linked, but "noindex, follow" and out of the sitemap.
    # kind (2026-10-14): field, state (a province, city and Remote too), combo (a field in a place), major or
    # employer, for the listing pages a paid listing's box may go on (PLACEMENT_KINDS); None for the rest.
    def add(path, title, desc, h1, crumbs, body, items=None, state=None, ld=(), index=True, dated=None, thin=False,
            kind=None):
        # lastmod is the day the page's newest listing was found: it moves when the page gains a
        # listing, not on every deploy, which is the only lastmod a search engine keeps trusting.
        about = items if items is not None else dated
        found = [str(x.get("first_seen") or "")[:10] for x in (listings if about is None else about)]
        # The live sitemap's lastmod is a floor: when the newest role on a page closes, the newest left
        # is older, and a lastmod that goes backwards is one a search engine stops trusting.
        found.append(live.get(path) or "" if isinstance(live, dict) else "")
        lastmod = max((f for f in found if f), default=None)
        # `title` is one form or several, longest first, without the suffix: fit_title picks the longest
        # that fits and adds " | InternScout" (2026-10-05). The description is clamped the same day.
        # was: every caller passed one title ending in " | InternScout", and the description as written.
        # A Head is fitted already (fit_head, 2026-10-13); fit_title would add a second suffix to a short one.
        if not isinstance(title, Head):
            title = fit_title(*([title] if isinstance(title, str) else title))
        desc = fit_description(desc)
        if about is not None:          # was: if items is not None:
            # A listing page is a CollectionPage of the site (2026-10-05), dated like its sitemap entry.
            ld = [*ld, {"@context": "https://schema.org", "@type": "CollectionPage", "@id": SITE + path,
                        "url": SITE + path, "name": h1, "description": desc, "isPartOf": {"@id": SITE_ID},
                        **({"dateModified": lastmod} if lastmod else {})}]
        pages.append({"path": path, "html": page(path, title, desc, h1, crumbs, body, updated, index=index,
                                                 feed=items is not None, ld=ld, thin=thin),
                      "items": items, "h1": h1, "state": state, "lastmod": lastmod, "index": index and not thin,
                      "thin": thin, "kind": kind})
        # was: ... page(..., ld=ld), ..., "index": index})

    # Each listing page's src (2026-10-04, see autoapply_card): seo-field for a field and a field in a
    # state, seo-state for a state, province or city, seo-employer, and seo-hub for the rest.
    root = ("/internships/", "Internships")
    page_name = {EMPLOYERS[nm]: nm for nm in by_company}     # employer page -> the name it goes by

    for t, items in sorted(fields.items()):
        name = field_title(t)
        path = f"/internships/{field_slug(t)}/"
        top_states = sorted(((k, len(v)) for (tt, k), v in combos.items() if tt == t), key=lambda kv: (-kv[1], kv[0]))
        # was: key=lambda kv: -kv[1]  (and so on below: every count that can tie is broken by name)
        # The US cities in a list of their own (2026-10-07), so "by state" still lists states.
        related = link_list(f"{name} internships by state",
                            [(f"{path}{state_slug(k)}/", US_STATES[k], n) for k, n in top_states
                             if k not in US_METRO_PAGES])
        related += link_list(f"{name} internships by city",
                             [(f"{path}{state_slug(k)}/", US_STATES[k], n) for k, n in top_states if k in US_METRO_PAGES])
        # was: emp = join_words(top(Counter(...), 3)), for the description; hiring_words says it now (2026-10-13).
        # The employers in this field that have a page of their own (2026-10-01), so search engines
        # reach the employer pages from the field pages as well as from single listing rows.
        hiring = Counter(EMPLOYERS[x["company_name"]] for x in items if x.get("company_name") in EMPLOYERS)
        related += link_list(f"Employers hiring in {lower_name(name)}",
                             [(pth, page_name[pth], k) for pth, k in sorted(hiring.items(), key=lambda kv: (-kv[1], kv[0]))[:RELATED]])
        # The list stops at RELATED; the rest are a click away (2026-10-07).
        if len(hiring) > RELATED:
            related += (f"<p class=\"more\"><a href=\"/internships/at/\">All {len(by_company):,} employers hiring "
                        f"now</a>, {len(hiring):,} of them in {esc(lower_name(name))}.</p>")
        # was: add(path, f"{name} Internships – {len(items):,} Open Now | InternScout", ...
        n = f"{len(items):,}"
        # The page's questions, on the page and as a FAQPage block (2026-10-05, listing_faq).
        qa = listing_faq(items, t, None, updated)
        fresh_n = digest_by_field[t]
        pitch = (f"{fresh_n:,} new {esc(lower_name(name))} internships in the last week."
                 if fresh_n >= DIGEST_MIN_NEW else "")
        # 2026-10-13: "Software Engineering Internships: 2,000+ Open" (listing_title, a count floor), and a
        # description that says which term most roles start in and who is hiring (listing_description).
        # was: [f"{name} Internships – {n} Open Now", f"{name} Internships – {n} Open", f"{name} Internships",
        #       f"{field_short(t)} Internships – {n} Open", f"{field_short(t)} Internships"], and
        #      f"{n} open {name} internships and co-ops for college students, updated {updated}. Employers
        #      include {emp}. Free search, no sign-up."
        co_ops = any("co_op" in (x.get("stage") or []) for x in items)
        add(path, listing_title([f"{name} Internships", f"{field_short(t)} Internships"], len(items)),
            listing_description(len(items), f"{lower_name(name)} internships{' and co-ops' if co_ops else ''}", "",
                                items, updated),
            f"{name} internships", [root, (path, name)],
            listing_body(items, f"in {lower_name(name)}", "", now, related, dash=dash_link([t]), fits=fits.get(path),
                         src="seo-field", faq=faq_section(qa), signup=signup_form(pitch, t)), items, ld=[faq_ld(qa)],
            kind="field")

    for k, items in sorted(states.items()):
        where = US_STATES[k]
        path = f"/internships/{state_slug(k)}/"
        top_fields = sorted(((t, len(v)) for (t, kk), v in combos.items() if kk == k), key=lambda tv: (-tv[1], tv[0]))
        related = link_list(f"Internships {in_place(k)} by field",
                            [(f"/internships/{field_slug(t)}/{state_slug(k)}/", field_title(t), n)
                             for t, n in top_fields])
        # A state links its cities, and a city its state (2026-10-07).
        cities = sorted(((m, len(states[m])) for m in US_METRO_PAGES if m in states and METRO_STATE[m] == k),
                        key=lambda kv: (-kv[1], kv[0]))
        related += link_list(f"Internships {in_place(k)} by city",
                             [(f"/internships/{state_slug(m)}/", m, n) for m, n in cities])
        crumbs = [root, (path, where)]
        if k in US_METRO_PAGES and METRO_STATE[k] in states:
            st = METRO_STATE[k]
            crumbs = [root, (f"/internships/{state_slug(st)}/", US_STATES[st]), (path, where)]
        loc = "remote" if k == "remote" else in_place(k)        # was: f"in {where}" (in_place adds "the")
        # was: add(path, f"Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout", ...
        head = f"Internships {'(Remote)' if k == 'remote' else in_place(k)}"
        qa = listing_faq(items, None, k, updated)
        # 2026-10-13: listing_title and listing_description. A Canadian page names co-ops in its title
        # when it has some: "co-op" is how students there search (Waterloo above all). was:
        # [f"{head} – {n} Open", head], and f"{n} open internships, co-ops and research roles {loc},
        # updated {updated}. Free search for college students, no sign-up."
        co_ops = any("co_op" in (x.get("stage") or []) for x in items)
        canadian = k in CANADA_KEYS or k in CA_METRO_PAGES
        subjects = ([f"Internships and Co-ops {in_place(k)}"] if canadian and co_ops else []) + [head]
        add(path, listing_title(subjects, len(items)),
            listing_description(len(items), "internships and co-ops" if co_ops else "internships",
                                "that are remote" if k == "remote" else loc, items, updated),
            f"Internships {'you can do remotely' if k == 'remote' else in_place(k)}", crumbs,
            listing_body(items, "", f" {loc}", now, related, state=k, dash=dash_link(state=k),
                         src="seo-state", faq=faq_section(qa)), items, k, ld=[faq_ld(qa)], kind="state")

    for (t, k), items in sorted(combos.items()):
        name, where = field_title(t), US_STATES[k]
        path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
        others = sorted(((kk, len(v)) for (tt, kk), v in combos.items() if tt == t and kk != k), key=lambda kv: (-kv[1], kv[0]))
        # Cities and states in two lists (2026-10-07), the field in this city's state first. was: one
        # list of every other place, which only held states.
        related = link_list(f"{name} internships in other states",
                            [(f"/internships/{field_slug(t)}/{state_slug(kk)}/", US_STATES[kk], n)
                             for kk, n in [o for o in others if o[0] == METRO_STATE.get(k)]
                             + [o for o in others if o[0] not in US_METRO_PAGES and o[0] != METRO_STATE.get(k)]][:RELATED])
        related += link_list(f"{name} internships by city",
                             [(f"/internships/{field_slug(t)}/{state_slug(kk)}/", US_STATES[kk], n)
                              for kk, n in others if kk in US_METRO_PAGES][:RELATED])
        loc = "remote" if k == "remote" else in_place(k)        # was: f"in {where}" (in_place adds "the")
        # was: add(path, f"{name} Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout", ...
        at = "(Remote)" if k == "remote" else in_place(k)
        qa = listing_faq(items, t, k, updated)
        at_short = PLACE_SHORT.get(k, at)
        # was: the four forms without at_short (2026-10-07: a place that needs "the" can run long).
        # 2026-10-13: listing_title and listing_description. was: [f"{name} Internships {at} – {n} Open",
        # f"{name} Internships {at}", f"{short} Internships {at} – {n} Open", f"{short} Internships {at}",
        # f"{name} Internships {at_short}", f"{short} Internships {at_short}"], and f"{n} open {name}
        # internships and co-ops {loc}, updated {updated}. Free search for college students, no sign-up."
        co_ops = any("co_op" in (x.get("stage") or []) for x in items)
        add(path, listing_title([f"{name} Internships {at}", f"{field_short(t)} Internships {at}",
                                 f"{name} Internships {at_short}", f"{field_short(t)} Internships {at_short}"],
                                len(items)),
            listing_description(len(items), f"{lower_name(name)} internships{' and co-ops' if co_ops else ''}",
                                "that are remote" if k == "remote" else loc, items, updated),
            f"{name} internships {loc}",
            [root, (f"/internships/{field_slug(t)}/", name), (path, where)],
            listing_body(items, f"in {lower_name(name)}", f" {loc}", now, related, state=k, dash=dash_link([t], k),
                         src="seo-field", faq=faq_section(qa)), items, k, ld=[faq_ld(qa)],
            thin=not combo_indexed(len(items), path, live, earning), kind="combo")     # 2026-10-13, INDEX_COMBO

    majors_made = []
    for m, tags, items, path in major_rows:
        name = m["name"]
        majors_made.append((path, name, len(items)))
        if path != f"/internships/for/{slugify(name)}-majors/":
            continue                 # folded into the field or major page with the same listings
        rel_tags = [t for t in (m.get("related") or []) if t in fields]
        related = link_list(f"Related fields for {name} majors",
                            [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t])) for t in rel_tags[:RELATED]])
        # was: add(path, f"Internships for {name} Majors – {len(items):,} Open | InternScout", ...
        add(path, [f"Internships for {name} Majors – {len(items):,} Open", f"Internships for {name} Majors"],
            f"{len(items):,} open internships, co-ops and research roles that fit {name} majors, updated "
            f"{updated}. Built for UMass Amherst students; free, no sign-up.",
            f"Internships for {name} majors",
            [root, ("/internships/for/", "By major"), (path, name)],
            listing_body(items, f"that fit {name} majors", "", now, related, dash=dash_link(tags),
                         fits=[n for n in fits[path] if n != name], src="seo-hub"), items, kind="major")

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
                                                  for t in main if t in fields])
                   # The field-in-a-place pages this employer's own roles are on (2026-10-07), most of
                   # its roles first: "Software Engineering in New York City" from a bank hiring there.
                   + link_list("Related internships by place",
                               [(f"/internships/{field_slug(t)}/{state_slug(k)}/", combo_label(t, k), len(combos[(t, k)]))
                                for (t, k), _ in sorted(Counter((t, k) for x in items for t in main for k in x["keys"]
                                                                if (t, k) in combos and t in (x.get("field_tags") or [])).items(),
                                                        key=lambda kv: (-kv[1], kv[0]))[:EMPLOYER_PLACES]]))
        # was: if k in US_STATES, which now holds the Canada and metro views as well.
        where = ",".join(top(Counter(k for x in items for k in x["keys"] if k in PLACES or k == "remote"), 6))
        # was: ",".join(k for k, _ in Counter(k for x in items for k in x["keys"] if k in US_STATES).most_common(6))
        # was: f"{name} Internships – {len(items):,} Open Now | InternScout", and a description of
        # "N open internships and co-ops at X for college students{about}". The start term in the title
        # matches "blue origin internships summer 2027"; places and pay are what a searcher picks on.
        term = main_term(items)
        # A place that names only a country ("Canada", 6 of Lyft's roles) says nothing beside "Toronto, ON".
        named = [p for p, _ in places(items) if p != "Remote" and not _COUNTRY_ONLY.match(p)][:3]
        pay = hourly_range(items)
        co_ops = sum(1 for x in items if "co_op" in (x.get("stage") or []))
        # Fewer places until the description fits DESC_MAX (2026-10-05): a board's "place" can be a
        # street address, and three of them made a 330-character description. was: always three.
        # 2026-10-07: employer pages ranked 8-10 for "<employer> internships" but got under 1% of clicks
        # (Under Armour 1 of 205, Campbell 0 of 119): the employer's own careers page sits above them, so
        # the snippet now leads with what that page doesn't show in one place: every open role on one
        # page, the listed pay, and how recently the newest was posted (a role found this week reads as
        # still open). was: "... Roles in <fields>. Updated <date>. Free, no sign-up."
        newest = max((d for d in (_when(x.get("posted_at") or x.get("first_seen")) for x in items) if d),
                     default=None)
        # 2026-10-13 (employer_title, employer_description): still under 1% (Under Armour 1 click in 348
        # impressions at 9.2). The title starts with the search's own words, "Under Armour Internships
        # Summer 2027", with a count floor that does not change on every refresh; the description keeps
        # the exact count, places, pay and newest date, and ends on why click (free, the employer's own
        # posting) where it fits. was: [f"{name} {term} Internships – {n} Open", f"{name} Internships
        # ({term}) – {n} Open", f"{name} Internships – {n} Open", f"{name} Internships"], and the
        # description "{n} open {name} internships for {term} on one page, in {places}. Listed pay
        # $a–$b/hour. Newest posted {day}. Free, no sign-up." built here.
        desc = employer_description(name, len(items), term, named, pay, newest, co_ops,
                                    own_links=all(own_posting(x) for x in items))
        add(path, employer_title(name, len(items), term),
            desc,
            f"Internships at {name}", [root, ("/internships/at/", "By employer"), (path, name)],
            listing_body(items, f"at {name}", "", now, related,
                         dash=dash_link(state=where, companies=spellings[name]), here=path, extra=facts,
                         src="seo-employer"), items, kind="employer")

    # Start term, paid, co-op, research and class-year pages (kinds()). A slug a field or state page
    # already uses is skipped, like a field slug that names a state.
    taken = {p["path"] for p in pages}
    kind_made = []
    for k in kinds(listings):
        path = f"/internships/{k['slug']}/"
        items = [x for x in listings if k["pick"](x)]
        if path not in taken and enough(len(items), path, MIN_KIND):
            kind_made.append((path, k, items))
    term_paths = {f"/internships/{slugify(t)}/": t for t in trackers}
    trackers = [t for t in trackers if any(p == f"/internships/{slugify(t)}/" for p, _, _ in kind_made)]
    for path, k, items in kind_made:
        by_tag = Counter(t for x in items for t in set(x.get("field_tags") or []) - SKIP_FIELDS if t in fields)
        # A summer's term page leads with its employers, newest-opened first (2026-10-07).
        lead = (f"<p class=\"more\"><a href=\"{tracker_path(term_paths[path])}\">Which employers have opened "
                f"{esc(term_paths[path])} internships</a>, newest first, with the day each opened.</p>"
                if path in term_paths and term_paths[path] in trackers else "")
        related = (lead + k.get("note", "")
                   + link_list(f"{k['h1'][0].upper()}{k['h1'][1:]} by field",
                               [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t]))
                                for t in top(by_tag, RELATED)])     # was: for t, _ in top.most_common(RELATED)
                   + link_list("More ways to browse", [(p, kk["h1"][0].upper() + kk["h1"][1:], len(v))
                                                       for p, kk, v in kind_made if p != path]))
        n = f"{len(items):,}"
        # The title loses what follows the count, then the count (2026-10-05): "Research Internships for
        # Undergraduates – 534 Open" is 64 with the suffix. was: k["title"].format(n=n) + " | InternScout"
        # 2026-10-13: the subject and its tails apart (fit_head), the count a floor (count_floor) and no
        # dash. was: full = k["title"].format(n=n), one string with " – {n} Open", and the forms
        # [full, full up to the count, full.split(" – ")[0]].
        floor = count_floor(len(items))
        add(path, fit_head([k["title"]], [tl.format(n=floor) for tl in k["tails"]] if floor else []),
            k["desc"].format(n=n, updated=updated),
            k["h1"], [root, (path, k["crumb"])],
            listing_body(items, k["what"], "", now, related, dash=dash_link(**k["dash"]),
                         tail=k.get("tail", TAIL), about=k.get("about", frozenset()), src="seo-hub"), items)

    # The trackers themselves (tracker_page), each under its term page in the breadcrumb trail.
    for t in trackers:
        term_path, path = f"/internships/{slugify(t)}/", tracker_path(t)
        year = int(t.split()[1])
        items = by_term[t]
        rows = opened_rows(items, year, d["baseline"])
        # The roles of the employers listed, one per role (was: len(unique_roles(items)), which also
        # counted rows whose employer name is not a name, real_company).
        t_, d_, h_, b_ = tracker_page(t, rows, sum(r[4] for r in rows), now, updated, term_path)
        add(path, t_, d_, h_, [root, (term_path, t), (path, "Who’s open now")], b_, dated=items)

    # "<field> internships near <city>" (2026-10-18, near_pages): all 500 built, the thin ones noindex. Judged
    # against the list pages made so far, so one that repeats a field, place or employer page stays out of search.
    rivals = [frozenset(x["id"] for x in p["items"]) for p in pages if p["index"] and p["items"]]
    if NEAR_ON:
        near_specs, near_grid = near_pages(listings, now, updated, live, earning, rivals)
        for spec in near_specs:
            add(**spec)
        t_, d_, b_ = near_hub(near_grid)
        add(NEAR_ROOT, t_, d_, "Internships near 50 US cities", [root, (NEAR_ROOT, "Near 50 US cities")], b_)

    new = [x for x in listings if fresh(x, now, d["baseline"])]
    # This page lists every new listing, and the email counts a role posted on two of an employer's
    # boards once, so when the two numbers differ the form says why its number is the smaller one.
    k = len(digest_new)
    new_pitch = ((f"{k:,} new internships in the last week" + (
        ", each role counted once even when an employer posted it twice." if k != len(new) else "."))
        if k >= DIGEST_MIN_NEW else "")
    if len(new) >= MIN_OPEN:
        add("/internships/new/", [f"New Internships This Week – {len(new):,} Found", "New Internships This Week"],
            f"{len(new):,} internships, co-ops and research roles for college students found in the last week, "
            f"Northeast and remote first. Updated {updated}. Free, no sign-up.",
            "New internships this week", [root, ("/internships/new/", "New this week")],
            listing_body(new, "found in the last week", "", now,
                         "<p class=\"more\">One feed for a whole club: this page's RSS feed carries the "
                         f"{NEW_FEED} newest roles found this week, so a Discord or Slack channel can follow "
                         "just this one.</p>"
                         # The soonest summer's employers, newest-opened first (2026-10-07).
                         + (f"<p class=\"more\">Employers rather than roles: <a href=\"{TRACKER[1]}\">"
                            f"{esc(TRACKER[0])} internships, who’s open now</a>, newest first.</p>" if TRACKER else ""),
                         dash=dash_link(new=True), src="seo-hub", signup=signup_form(new_pitch)), new)
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

    # The site's figures on one page (2026-10-05, numbers_page), before the hubs so the hub, /about/ and
    # llms.txt can link it. Kept once live like the pay page; MIN_KIND, since five roles make no statistics.
    numbers = enough(len(listings), NUMBERS_PATH, MIN_KIND)
    if numbers:
        t_, d_, b_, ld_ = numbers_page(facts, listings, fields, states, rep, len(new), kind_made, now, updated)
        add(NUMBERS_PATH, t_, d_, "InternScout by the numbers", [root, (NUMBERS_PATH, "By the numbers")], b_, ld=ld_)

    # Hubs last, so they only link to pages that exist.
    add("/internships/at/", [f"Internships by Employer – {len(by_company):,} Employers", "Internships by Employer"],
        f"Open internships and co-ops at {len(by_company):,} employers hiring college students now, from each "
        "employer's public job board. Free, no sign-up.",
        "Internships by employer", [root, ("/internships/at/", "By employer")],
        f"<p class=\"lede\">Employers with about {MIN_EMPLOYER} or more open student roles, most of them "
        "internships, co-ops or research. InternScout is not affiliated with any of them.</p>"
        # The ones hiring most first (2026-10-07), then every one by name.
        + link_list("Hiring the most right now", top_employers(by_company, HUB_TOP))
        + (f"<p class=\"more\"><a href=\"{TRACKER[1]}\">{esc(TRACKER[0])}: who’s open now</a>, the employers "
           f"that have opened {esc(TRACKER[0])} internships, newest first.</p>" if TRACKER else "")
        + link_list("Every employer, A to Z", sorted(((EMPLOYERS[n], n, len(v)) for n, v in by_company.items()),
                                        key=lambda e: (e[1].lower(), e[1]))))   # was: key=lambda e: e[1].lower()
    add("/internships/for/", [f"Internships by Major – {len(majors_made)} Majors", "Internships by Major"],
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
             "</a></li>" + (f"<li><a href=\"{NEAR_ROOT}\">By field near 50 US cities</a></li>" if NEAR_ON else "") + (f"<li><a href=\"/internships/new/\">New this week</a> <span class=\"n\">{len(new):,}</span></li>"
                            if len(new) >= MIN_OPEN else "")
           + "".join(f"<li><a href=\"{p}\">{esc(k['h1'][0].upper() + k['h1'][1:])}</a> "
                     f"<span class=\"n\">{len(v):,}</span></li>" for p, k, v in kind_made)
           + (f"<li><a href=\"{pay_path}\">Highest-paying internships</a> <span class=\"n\">{len(rep['roles']):,}</span></li>"
              if rep else "")
           + (f"<li><a href=\"{NUMBERS_PATH}\">InternScout by the numbers</a></li>" if numbers else "")
           + "".join(f"<li><a href=\"{tracker_path(t)}\">{esc(t)}: who’s open now</a></li>" for t in trackers)
           + "</ul></section>")
    # was: f"Browse {len(listings):,} Open Internships by Field, State and Major | InternScout" (70 characters)
    add("/internships/", [f"Browse {len(listings):,} Open Internships by Field, State and Major",
                          f"{len(listings):,} Internships by Field, State and Major",
                          "Browse Internships by Field, State and Major"],
        f"{len(listings):,} open internships, co-ops and research roles for college students, updated "
        f"{updated}. Browse by field, state or major. Free, no sign-up.",
        "Browse internships", [root], hub, ld=[ORGANIZATION, WEBSITE])
    # was: "Browse internships", [root], hub)   (no JSON-LD: a one-item breadcrumb is none, see page)

    # What InternScout is, for people and for answer engines (2026-10-02). After the hubs: they link
    # only pages that exist.
    qa = about_answers(facts, len(majors_made), len(new), rep, updated, numbers)
    # was: qa = about_answers(facts, len(majors_made), len(new), rep)
    t_, d_, b_, ld_ = about_page(facts, qa, updated)
    add("/about/", t_, d_, "About InternScout", [("/", "InternScout"), ("/about/", "About")], b_, ld=ld_)
    t_, d_, b_ = compare_page(facts)
    add("/compare/", t_, d_, "InternScout vs Simplify vs Jobright", [("/", "InternScout"), ("/compare/", "Compare")], b_)
    t_, d_, b_, ld_ = pricing_page()
    add("/pricing/", t_, d_, "Plans and prices", [("/", "InternScout"), ("/pricing/", "Pricing")], b_, ld=ld_)
    # The weekly email's own page (2026-10-06), the one address the brand posts, the extension, flyers
    # and clubs link. Indexed only once the form has an address; until then it says sign-ups aren't open.
    t_, d_, b_ = digest_page(digest_new, digest_by_field, len(new) >= MIN_OPEN)
    add(DIGEST_PATH, t_, d_, "New internships in your inbox every Monday. Free.",
        [("/", "InternScout"), (DIGEST_PATH, "Weekly email")], b_, index=bool(DIGEST_FORM))
    # 2026-10-23: was: related sections recommended noindex destinations without consulting the
    # finished page list. Prefer indexed recommendations, retaining the full browsing catalogues.
    # Revert: remove these two lines; no page's eligibility, canonical or sitemap inclusion changes.
    from .related_pages import prefer_indexed
    prefer_indexed(pages)
    global TEXTS, HOME
    HOME = home_browse(pages, by_company, fields, states, trackers, len(new) >= MIN_OPEN, len(majors_made))
    # llms.txt names only pages search engines are asked to index (2026-10-13): not /digest/ before it has a
    # form, nor a thin page. was: every page made.
    made = {p["path"]: (p["h1"], len(p["items"]) if p["items"] is not None else 0) for p in pages if p["index"]}
    TEXTS = llms_files(facts, made, rep, len(majors_made), len(by_company), len(new), updated)
    return pages


# ---- the dashboard's "Browse" section (2026-10-07)
# Search Console (2026-10-07): 687 pages "discovered - currently not indexed", among them Boeing's, Cisco's
# and AMD's employer pages and whole field pages, all three clicks from the home page (dashboard ->
# /internships/ -> /internships/at/ -> employer). A crawler spends its visits on what the pages it
# trusts most link to, and the home page is the one it trusts most. So the dashboard's HTML (written
# into the site's index.html at deploy, outside the React root) links the biggest employers, every field
# page and the places students search, and every field page links all of its field-in-a-place pages:
# each of those is then one or two clicks from the home page.
HUB_TOP = 24            # employers in /internships/at/'s "Hiring the most right now"
HOME_EMPLOYERS = 30     # ...and in the dashboard's Browse section
HOME_STATES_MORE = 8    # states outside the Northeast the Browse section names, the biggest first
HOME_START, HOME_END = "<!-- browse:start -->", "<!-- browse:end -->"


def top_employers(by_company: dict[str, list], n: int) -> list[tuple[str, str, int]]:
    """(page, name, open roles) of the n employers with the most open roles; ties by name."""
    return [(EMPLOYERS[nm], nm, len(v)) for nm, v in
            sorted(by_company.items(), key=lambda kv: (-len(kv[1]), kv[0].lower(), kv[0]))[:n]]


def home_browse(pages: list[dict], by_company: dict[str, list], fields: dict, states: dict, trackers: list[str],
                new: bool, majors: int) -> str:
    """The dashboard's Browse section: plain links with their counts, each to a page this build made."""
    made = {p["path"] for p in pages}

    def ul(links) -> str:
        return "<ul>" + "".join(f"<li><a href=\"{esc(h)}\">{esc(t)}</a>"
                                + (f"<span class=\"n\">{n:,}</span>" if n is not None else "") + "</li>"
                                for h, t, n in links if h in made) + "</ul>"

    now_links = ([(tracker_path(t), f"{t}: who’s open now", None) for t in trackers]
                 + [(f"/internships/{slugify(t)}/", f"{t} internships", None) for t in trackers]
                 + ([("/internships/new/", "New this week", None)] if new else [])
                 + [("/internships/paid/", "Paid internships", None), ("/internships/highest-paying/", "Highest-paying", None),
                    ("/internships/for/", f"By major ({majors})", None), (NUMBERS_PATH, "InternScout by the numbers", None)])
    us = [k for k in states if k in PLACES and k not in CANADA_KEYS]
    northeast = [k for k in ("remote", "MA", "NY", "NJ", "CT", "RI", "NH", "VT", "ME", "PA") if k in states]
    others = sorted((k for k in us if k not in northeast), key=lambda k: (-len(states[k]), k))[:HOME_STATES_MORE]
    cities = sorted((m for m in US_METRO_PAGES if m in states), key=lambda m: (-len(states[m]), m))
    place = lambda k: (f"/internships/{state_slug(k)}/", "Remote" if k == "remote" else US_STATES[k], len(states[k]))  # noqa: E731
    return ("<div class=\"wrap\"><section class=\"browse\" aria-labelledby=\"browse-title\">"
            "<h2 id=\"browse-title\">Browse open internships</h2>"
            "<h3>Employers hiring the most</h3>" + ul(top_employers(by_company, HOME_EMPLOYERS))
            + f"<p><a href=\"/internships/at/\">All {len(by_company):,} employers hiring now</a></p>"
            + "<h3>Right now</h3>" + ul(now_links)
            + "<h3>By field</h3>" + ul(sorted(((f"/internships/{field_slug(t)}/", field_title(t), len(v))
                                               for t, v in fields.items()), key=lambda p: p[1]))
            + "<h3>By place</h3>" + ul([place(k) for k in northeast + cities + others])
            + "<p><a href=\"/internships/\">Every state, province and major</a></p>"
            + "</section></div>")


def not_found(updated: str) -> str:
    """GitHub Pages serves 404.html for any missing path, including a landing page whose listings
    closed. Without it a visitor from an old search result gets GitHub's own page, with no way back."""
    body = ("<p class=\"lede\">This page isn't here. If it listed internships, they may have closed "
            "since it was made.</p>"
            "<p><a class=\"cta\" href=\"/internships/\">Browse open internships</a></p>"
            "<p>Or <a href=\"/\">open the dashboard</a> to search every listing.</p>")
    return page("/404.html", "Page not found | InternScout", "This page is not on InternScout.",
                "Page not found", [], body, updated, index=False)


# ---------------------------------------------------------------- paid listings (placements)
# B2 plan section 6 (2026-10-14). A post-pass: add_paid_boxes runs after build(), so every list, fold,
# index, noindex, sitemap, feed, lastmod and JSON-LD decision is made before a box exists, and each page
# is byte-identical to the build without placements once its <!--paid-->...<!--/paid--> span is taken out
# (tests/test_seo_pages.py, T7). The rule: payment never changes a score, an order, a filter, a count or
# what Auto-Apply does. The code says "placement"; "paid" is the pay filter (paid=True above), and appears
# only in the label and the markup the plan fixes.

LISTINGS: list[dict] = []          # the listings the last build() kept (load), for main()

# The page kinds a box may go on: they have a field, a place or an employer for it to fit. Not the hub,
# /internships/new/, the start-term and other kind pages, the trackers, or any page without a list.
PLACEMENT_KINDS = frozenset({"field", "state", "combo", "major", "employer"})
PLACEMENT_START, PLACEMENT_END = "<!--paid-->", "<!--/paid-->"
PLACEMENT_AFTER = 3                 # rows above the box; after the last one on a shorter list
PLACEMENTS_FILE = "placements.json"     # in <site_dir>/data, for the dashboard and the weekly email
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def placement_box(x: dict, pl: dict, state: str | None = None) -> str:
    """One paid listing's box, between the markers, as B2 6.2 fixes it: "Paid listing", then "Ad" before
    the company name; the row's own title and grey line (row_meta); a posting link marked
    rel="sponsored noopener" with no data-aa (so the Auto-Apply offer never fires for it) and no company
    link; data-nosnippet to keep it out of search snippets. The inline script takes the box out once its
    end date (exclusive) has come, even if no deploy has run since. data-placement (2026-10-14, S9) carries
    the placement's id, for js/count.js: "shown" once the box is half on screen and "open" when its link
    is pressed, once per page load each; the id and the page's path are all it sends."""
    end = str(pl.get("end") or "")
    href = esc(safe_url(x.get("apply_url")) or "")
    if not _DAY_RE.match(end) or not href:
        return ""
    return (f'{PLACEMENT_START}<li class="paid" data-placement="{esc(pl.get("id") or "")}" data-nosnippet '
            'aria-label="Paid listing, not part of this page\'s list">\n'
            '<p class="paid-h">Paid listing <a href="/privacy.html#paid-listings">Why am I seeing this?</a></p>\n'
            f'<div class="co"><span class="ad">Ad</span> {esc(x.get("company_name") or "")}</div>\n'
            f'<div class="role">{esc(x.get("title") or "")}</div>\n'
            f'<div class="meta">{row_meta(x, state)}</div>\n'
            f'<a class="go" href="{href}" rel="sponsored noopener" target="_blank">Open posting</a>\n'
            f'</li><script>if(new Date().toISOString().slice(0,10)>="{end}")'
            f'document.currentScript.previousElementSibling.remove()</script>{PLACEMENT_END}')


def strip_placements(text: str) -> str:
    """text with every paid box (marker to marker) taken out."""
    return re.sub(re.escape(PLACEMENT_START) + ".*?" + re.escape(PLACEMENT_END), "", text, flags=re.S)


def _after_row(text: str) -> int:
    """Where a box goes in a page: after row PLACEMENT_AFTER of its list, or after its last row; -1
    when the page has no list or the list no rows."""
    start = text.find('<ul class="jobs">')
    if start < 0:
        return -1
    end = text.find("</ul>", start)
    at, n = start, 0
    while n < PLACEMENT_AFTER:
        nxt = text.find("</li>", at, end)
        if nxt < 0:
            break
        at, n = nxt + len("</li>"), n + 1
    return at if n else -1


def add_paid_boxes(pages: list[dict], kept: list[dict], today: str) -> list[dict]:
    """pages with at most one paid listing's box each (MAX_PER_PAGE), on the listing pages
    (PLACEMENT_KINDS) whose own items include its listing. kept: placements.resolve's. When two or more
    fit one page, a hash of the path and the day picks one, so two builds on the same day are the same
    and price never matters. Only "html" changes; a page with no box is the same dict."""
    from .placements import MAX_PER_PAGE
    if not kept or MAX_PER_PAGE < 1:
        return pages
    out = []
    for p in pages:
        if p.get("kind") not in PLACEMENT_KINDS or not p.get("items"):
            out.append(p)
            continue
        here = {str(x.get("id")): x for x in p["items"]}
        fits = sorted((pl for pl in kept if pl["listing_id"] in here), key=lambda pl: pl["id"])
        at = _after_row(p["html"]) if fits else -1
        if at < 0:
            out.append(p)
            continue
        pl = fits[int(hashlib.sha256((p["path"] + today).encode()).hexdigest(), 16) % len(fits)]
        box = placement_box(here[pl["listing_id"]], pl, p.get("state"))
        out.append(dict(p, html=p["html"][:at] + box + p["html"][at:]) if box else p)
    return out


def write_placements(site_dir: str, kept: list[dict], today: str) -> None:
    """<site_dir>/data/placements.json: the placements kept today, public fields only."""
    from .placements import public
    folder = os.path.join(site_dir, "data")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, PLACEMENTS_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"day": today, "placements": public(kept)}, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def today_utc() -> str:
    """Today's UTC day. A placement's dates are UTC days, start inclusive and end exclusive."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


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
    # /employers/ (2026-10-13) is hand-written in docs/employers/index.html, like install.html.
    # was: urls = [("/", hub), ("/install.html", None), ("/privacy", None), ("/terms", None)] + \
    urls = [("/", hub), ("/install.html", None), ("/employers/", None), ("/privacy", None), ("/terms", None)] + \
           [(p["path"], p.get("lastmod")) for p in pages if p.get("index", True)]
    # A noindex page (index False: /digest/ before its form has an address) stays out of the sitemap.
    # was: [(p["path"], p.get("lastmod")) for p in pages]
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
        # Google and Bing skip the per-page RSS feeds (2026-10-07). Search Console: 687 pages "discovered -
        # currently not indexed", and most of the 21 "crawled - currently not indexed" were feed.xml files,
        # one per page and each linked from its page's head, so the two engines spent their visits on
        # ~1,360 feeds instead of the pages. Feed readers and every other crawler keep the "*" group. The
        # named group replaces "*" for those two (the warning above), so it says Allow: / again.
        # was: f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n" after the comment.
        f.write("# Every crawler is welcome, AI search and answer engines included: GPTBot, OAI-SearchBot,\n"
                "# ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, Bingbot and\n"
                f"# Applebot-Extended. A summary for language models: {SITE}/llms.txt\n"
                "User-agent: *\nAllow: /\n\n"
                "# Google and Bing: every page, but not the per-page RSS feeds, which are for feed readers.\n"
                "User-agent: Googlebot\nUser-agent: Bingbot\nAllow: /\nDisallow: /*feed.xml$\n\n"
                f"Sitemap: {SITE}/sitemap.xml\n")
        # was: f.write(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
        # was: f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
        #              f"Disallow: /data/\n\nSitemap: {SITE}/sitemap.xml\n")
    # llms.txt and llms-full.txt (2026-10-02): not in the sitemap, which lists pages; answer engines
    # look for them at the root by name, and robots.txt and /about/ point to them.
    for name, text in TEXTS.items():
        with open(os.path.join(site_dir, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    # The thin pages this deploy serves (INDEX_COMBO), for the next deploy's held_paths (2026-10-13).
    with open(os.path.join(site_dir, HELD_FILE), "w", encoding="utf-8", newline="\n") as f:
        f.write("# InternScout pages served with noindex, follow (too few roles to ask search engines to index).\n"
                + "".join(p["path"] + "\n" for p in sorted(pages, key=lambda p: p["path"]) if p.get("thin")))
    # The dashboard's Browse section (home_browse), between its two markers. Only what is between them
    # changes, so writing it twice gives the same file.
    home = os.path.join(site_dir, "index.html")
    if HOME and os.path.isfile(home):
        with open(home, encoding="utf-8", newline="") as f:
            text = f.read()
        start, end = text.find(HOME_START), text.find(HOME_END)
        if 0 <= start < end:
            text = text[:start + len(HOME_START)] + HOME + text[end:]
            with open(home, "w", encoding="utf-8", newline="") as f:
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


def held_paths(listing: str) -> frozenset[str]:
    """The noindex pages the site was serving before this build (HELD_FILE); empty if there was none."""
    try:
        with open(listing, encoding="utf-8") as f:
            return frozenset(s for s in (line.strip() for line in f) if s.startswith("/internships/"))
    except (OSError, UnicodeDecodeError):
        return frozenset()


def main(argv: list[str]) -> None:
    """python -m internscout.seo_pages SITE_DIR [LIVE_SITEMAP [LIVE_NOINDEX_LIST]] [--placements PATH]
    [--placements-report PATH]

    --placements PATH (2026-10-14): the Worker's GET /placements answer, which the pages workflow
    fetches only when the repo variable INTERNSCOUT_PLACEMENTS_URL is set and otherwise writes as
    {"placements":[]}. With it, the build writes <site_dir>/data/placements.json (an empty list when the
    file is missing or malformed), prints a ::warning:: for each placement it drops, and adds the boxes.
    Without it, nothing about placements is written or changed.

    --placements-report PATH (2026-10-14), with --placements: also writes PATH, the build's report for
    placements.record_runs (placements.report: the UTC day, the ids kept and the ids dropped with their
    reasons). The pages workflow writes it outside the site, so it is never published."""
    argv = list(argv)
    placements_path = None
    report_path = None
    if "--placements-report" in argv:
        i = argv.index("--placements-report")
        report_path = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i:i + 2]
    if "--placements" in argv:
        i = argv.index("--placements")
        placements_path = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i:i + 2]
    site_dir = argv[1] if len(argv) > 1 else "docs"
    pages = build(site_dir, live_paths(argv[2]) if len(argv) > 2 else {},
                  held_paths(argv[3]) if len(argv) > 3 else frozenset())
    # was: pages = build(site_dir, live_paths(argv[2]) if len(argv) > 2 else {})
    built = pages                  # as build() made them, before any paid box, for the feeds
    today = today_utc()
    if placements_path is not None:
        from . import placements
        kept, dropped = placements.resolve(placements.read(placements_path),
                                           {str(x["id"]): x for x in LISTINGS}, today)
        for line in placements.warnings(kept, dropped):
            print(line)
        write_placements(site_dir, kept, today)
        if report_path:
            # Only a record for refunds: a report that cannot be written never stops the build.
            try:
                with open(report_path, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(placements.report(kept, dropped, today), f, separators=(",", ":"))
                    f.write("\n")
            except OSError:
                print("::warning::placements report not written")
        pages = add_paid_boxes(pages, kept, today)
        print(f"[seo] placements: {len(kept)} kept, {len(dropped)} dropped")
    write(site_dir, pages)
    # The role index the employer buy page searches and the Worker checks orders against (2026-10-19,
    # role_index). Here and not in build(), which writes nothing: growth/report.py calls build() on docs/.
    from . import role_index       # role_index imports this module, so not at the top
    shards = role_index.write(site_dir, LISTINGS, GENERATED or datetime.now(timezone.utc), today)
    print(f"[seo] role index: {sum(shards.values())} roles in {len(shards)} shards")
    from . import feeds            # feeds imports this module, so not at the top
    # The date is passed, not left to feeds to read from seo_pages.GENERATED: run as
    # `python -m internscout.seo_pages` this module is __main__, and the internscout.seo_pages that
    # feeds imports is a second copy whose build() never ran, so its GENERATED is None.
    feeds.write_all(site_dir, built, GENERATED)     # was: feeds.write_all(site_dir, pages)
    # The embedded widget needs real per-field coverage, not the dashboard's 60-row preview.
    from . import widget_data
    widget_data.write(site_dir, LISTINGS, GENERATED, today_utc())
    print(f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt into {site_dir}")


if __name__ == "__main__":
    main(sys.argv)
