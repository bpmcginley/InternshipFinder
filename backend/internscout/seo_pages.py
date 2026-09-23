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

import html
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
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
MIN_EMPLOYER = 10       # open roles an employer needs before it gets a page of its own
PER_PAGE = 40           # listings shown on one page; the dashboard has the rest
NEW_DAYS = 7
RELATED = 12            # related-page links per section

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
PLACES = set(US_STATES) - {"remote"}      # the states a posting can be filed in

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


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def field_slug(tag: str) -> str:
    return FIELD_TITLES.get(tag, (None, None))[1] or slugify(tag)


def state_slug(key: str) -> str:
    return slugify(US_STATES.get(key, key))


esc = html.escape


def safe_url(url) -> str | None:
    u = (url or "").strip()
    return u if u.lower().startswith(("https://", "http://")) else None


# ---------------------------------------------------------------- data

def load(site_dir: str) -> dict:
    data = os.path.join(site_dir, "data")
    with open(os.path.join(data, "listings", "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    with open(os.path.join(data, "majors.json"), encoding="utf-8") as f:
        majors = json.load(f)
    by_id: dict[str, dict] = {}
    for key, meta in index["files"].items():
        with open(os.path.join(data, meta["file"]), encoding="utf-8") as f:
            for x in json.load(f):
                if x.get("status") != "open" or not safe_url(x.get("apply_url")):
                    continue
                keep = by_id.setdefault(x["id"], dict(x, keys=set()))
                keep["keys"].add(key)
    listings = list(by_id.values())
    return {"generated_at": index.get("generated_at"), "listings": listings,
            "majors": majors.get("majors", []), "baseline": baseline_day(listings)}


def baseline_day(listings: list[dict]) -> str | None:
    """The day first_seen began to be kept, if it still dominates the data.

    first_seen only survives from one export to the next since 2026-09-18, so everything already
    open that day carries that date: 11,146 of 12,792 listings on 2026-09-23. Counted as "found this
    week", that made half the site new, and a post said 110 new data science roles when 31 were.
    A day holding more than a third of all listings is that start, not a week's finds."""
    days = Counter(str(x.get("first_seen") or "")[:10] for x in listings if x.get("first_seen"))
    if not days:
        return None
    day, n = min(days.items())
    return day if n * 3 > len(listings) else None


def _when(stamp) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def newest_first(items: list[dict]) -> list[dict]:
    """The dashboard's order (docs/js/app.js, "newer"): dated postings first, newest posting first,
    then by when a scan found it. first_seen alone would put a 2024 posting found this week on top."""
    return sorted(items, key=lambda x: (bool(x.get("posted_at")), x.get("posted_at") or "", x.get("first_seen") or ""),
                  reverse=True)


def is_paid(x: dict) -> bool:
    return bool(x.get("salary")) or ((x.get("insights") or {}).get("pay") == "paid")


def place(x: dict, state: str | None = None) -> str:
    """Where the role is. On a state's page, the location in that state comes first: a Massachusetts
    page that says "New York, NY +5" reads as a listing filed in the wrong place."""
    regions = x.get("regions") or []
    if not regions:
        return "Remote" if x.get("is_remote") else "United States"
    if state == "remote":
        lead = next((g for g in regions if g.get("kind") == "remote" or g.get("state") == "Remote"), regions[0])
    elif state:
        lead = next((g for g in regions if g.get("state") == state), regions[0])
    else:
        lead = regions[0]
    shown = "Remote" if lead.get("state") == "Remote" else lead["loc"]
    return shown + (f" +{len(regions) - 1}" if len(regions) > 1 else "")


# UMass Amherst students are the audience: roles within reach of western Massachusetts, and remote
# ones, are the ones they can take. Pages that span the country list those first.
HOME_STATES = {"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "remote"}


def fresh(x: dict, now: datetime, baseline: str | None = None) -> bool:
    """Found in the last NEW_DAYS, and not an old posting a scan has only just reached, nor one that
    was already open on the day first_seen began (baseline_day)."""
    seen, posted = _when(x.get("first_seen")), _when(x.get("posted_at"))
    if baseline and str(x.get("first_seen") or "")[:10] <= baseline:
        return False
    return bool(seen and now - seen <= timedelta(days=NEW_DAYS)
                and (posted is None or now - posted <= timedelta(days=2 * NEW_DAYS)))


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

def summary(items: list[dict], what: str, where: str) -> str:
    """The page's opening paragraph, every clause computed from its own listings."""
    n = len(items)
    parts = [f"{plural(n, 'open student role')} {what}{where}, from internships to co-ops and research."]
    stages = Counter(s for x in items for s in x.get("stage") or [])
    extra = [plural(stages[s], label) for s, label in
             (("co_op", "co-op"), ("research", "research position"), ("fellowship", "fellowship"),
              ("part_time", "part-time role")) if stages.get(s)]
    if extra:
        parts.append(f"That includes {join_words(extra)}.")
    paid = sum(1 for x in items if is_paid(x))
    if paid:
        parts.append(f"{paid * 100 // n}% list pay or say they are paid.")
    # A bare season ("Summer") is a board that gave no year; beside "Summer 2027" it reads as a repeat.
    terms = Counter(x["term"] for x in items if x.get("term") and re.search(r"\d{4}|round", str(x["term"])))
    if terms:
        top = [t for t, _ in terms.most_common(2)]
        parts.append(f"The most common start {'term is' if len(top) == 1 else 'terms are'} {join_words(top)}.")
    employers = [c for c, _ in Counter(x["company_name"] for x in items).most_common(5)]
    if len(employers) >= 3:
        parts.append(f"Employers with the most openings: {join_words(employers)}.")
    return " ".join(esc(p) for p in parts)


EMPLOYERS: dict[str, str] = {}   # company name -> its employer page, set by build()


def listing_rows(items: list[dict], now: datetime, state: str | None = None, here: str | None = None) -> str:
    rows = []
    ordered = newest_first(items) if state else near_home_first(items)
    for x in ordered[:PER_PAGE]:
        new = fresh(x, now, BASELINE)
        stage = ", ".join(s.replace("_", "-") for s in (x.get("stage") or []) if s != "internship")
        meta = [esc(place(x, state))]
        if x.get("term"):
            meta.append(esc(str(x["term"])))
        if stage:
            meta.append(esc(stage))
        pay = esc(str(x["salary"])) if x.get("salary") else ("Paid" if is_paid(x) else "")
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
    """The company's name, linked to its employer page when it has one (and it is not this page)."""
    path = EMPLOYERS.get(name)
    return f'<a href="{esc(path)}">{esc(name)}</a>' if path and name != here else esc(name)


def link_list(title: str, links: list[tuple[str, str, int]]) -> str:
    if not links:
        return ""
    lis = "".join(f"<li><a href=\"{esc(href)}\">{esc(label)}</a> <span class=\"n\">{n:,}</span></li>"
                  for href, label, n in links)
    return f"<section class=\"rel\"><h2>{esc(title)}</h2><ul>{lis}</ul></section>"


CSS = """
:root{--paper:#f6f4ef;--panel:#fffefb;--ink:#17191c;--ink2:#454a52;--ink3:#646a73;--rule:#e2ded4;
--accent:#1d5c46;--accent-soft:#e3eee8;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#131416;--panel:#1a1b1e;--ink:#ecebe6;--ink2:#b8b6af;
--ink3:#95948e;--rule:#2c2d31;--accent:#7cc3a1;--accent-soft:#1c2a24;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.6 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 64px}a{color:var(--accent)}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px 20px;flex-wrap:wrap;
padding:22px 0 14px;border-bottom:1px solid var(--ink)}
.mark{font:600 22px/1 "Source Serif 4",Georgia,serif;color:var(--ink);text-decoration:none}
nav a{color:var(--ink2);font-size:14px;text-decoration:none;margin-left:14px}
.crumbs{font-size:14px;color:var(--ink3);margin:22px 0 0}.crumbs a{color:var(--ink3)}
h1{font:600 32px/1.2 "Source Serif 4",Georgia,serif;margin:10px 0 8px}
.lede{color:var(--ink2);font-size:17px;margin:0 0 6px}.updated{color:var(--ink3);font-size:14px;margin:0}
.cta{display:inline-block;margin:18px 0 8px;padding:10px 16px;border-radius:6px;background:var(--accent);
color:var(--paper);font-weight:600;text-decoration:none}
ul.jobs{list-style:none;padding:0;margin:24px 0;border-top:1px solid var(--rule)}
.job{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.co{font-weight:600}.role{grid-column:1}.meta{grid-column:1;color:var(--ink3);font-size:14px}
.pay{color:var(--ink2)}.new{font-size:12px;color:var(--accent);font-weight:600;margin-left:6px}
.go{grid-column:2;grid-row:1/span 3;align-self:center;font-size:14px;white-space:nowrap}
.more,.follow{color:var(--ink2)}section.rel h2{font:600 20px/1.3 "Source Serif 4",Georgia,serif;margin:36px 0 8px}
section.rel ul{list-style:none;padding:0;margin:0;columns:2;column-gap:28px}
section.rel li{padding:3px 0;break-inside:avoid}.n{color:var(--ink3);font-size:13px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--ink3);font-size:14px}
footer a{color:var(--ink2)}@media (max-width:560px){h1{font-size:26px}section.rel ul{columns:1}
.job{grid-template-columns:1fr}.go{grid-column:1;grid-row:auto;margin-top:4px}}
"""

def beacon_from(site_dir: str) -> str:
    """The analytics snippet exactly as the dashboard carries it, so there is one copy to change.
    (Its token is public by design, but a second hard-coded copy here could drift from the first.)"""
    try:
        with open(os.path.join(site_dir, "index.html"), encoding="utf-8") as f:
            m = re.search(r"<script[^>]*cloudflareinsights[^>]*></script>", f.read())
        return m.group(0) if m else ""
    except OSError:
        return ""


BEACON = ""   # set by build() from the site's own index.html
BASELINE: str | None = None   # set by build(): see baseline_day


def page(path: str, title: str, description: str, h1: str, crumbs: list[tuple[str, str]],
         body: str, updated: str, index: bool = True, feed: bool = False) -> str:
    url = SITE + path
    crumb_html = " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1]) + \
                 (f" › {esc(crumbs[-1][1])}" if crumbs else "")
    ld = {"@context": "https://schema.org", "@type": "BreadcrumbList",
          "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": t, "item": SITE + h}
                              for i, (h, t) in enumerate(crumbs)]}
    # "</" inside a script block would end it early; JSON allows the escaped form.
    ld_json = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
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


def dash_link(fields=(), state: str | None = None, search: str | None = None) -> str:
    """The dashboard, opened on this page's fields, state or search (docs/js/app.js reads ?field=,
    ?state= and ?q=; the dashboard's canonical link keeps these one page to search engines)."""
    q = [f"field={quote(','.join(fields), safe=',')}"] if fields else []
    if state:
        q.append(f"state={quote(state)}")
    if search:
        q.append(f"q={quote(search)}")
    return "/?" + "&amp;".join(q) if q else "/"


def fits_line(majors: list[str]) -> str:
    return (f"<p class=\"fits\">The page for {esc(join_words(sorted(majors)))} "
            f"{'majors' if len(majors) > 1 else 'majors too'}.</p>") if majors else ""


def listing_body(items: list[dict], what: str, where: str, now: datetime, related: str,
                 state: str | None = None, dash: str = "/", fits: list[str] | None = None,
                 here: str | None = None) -> str:
    more = len(items) - PER_PAGE
    order = "newest" if state else "newest, Northeast and remote first,"
    return (f"<p class=\"lede\">{summary(items, what, where)}</p>" + fits_line(fits or []) +
            f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
            f"<ul class=\"jobs\">{listing_rows(items, now, state, here)}</ul>"
            + (f"<p class=\"more\">Showing the {PER_PAGE} {order} of {len(items):,}. "
               f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>" if more > 0 else "")
            + "<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
              "<a href=\"feed.xml\">RSS feed</a></p>"
            + related)


# ---------------------------------------------------------------- build

def build(site_dir: str, live: set[str] | frozenset[str] = frozenset()) -> list[dict]:
    """live: the paths the site is serving now (from its sitemap), which get the lower keep_at bar."""
    global BEACON, BASELINE
    BEACON = beacon_from(site_dir)
    d = load(site_dir)
    BASELINE = d["baseline"]
    listings = d["listings"]
    now = _when(d["generated_at"]) or datetime.now(timezone.utc)
    updated = f"{now:%B} {now.day}, {now.year}"
    pages: list[dict] = []

    by_field: dict[str, list] = {}
    by_state: dict[str, list] = {}
    for x in listings:
        for t in set(x.get("field_tags") or []) - SKIP_FIELDS:
            by_field.setdefault(t, []).append(x)
        for k in x["keys"]:
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
    for t, items in fields.items():
        for k in states:
            hit = [x for x in items if k in x["keys"]]
            local = [x for x in hit if len(x["keys"] & PLACES) < SPREAD]
            if enough(len(local), f"/internships/{field_slug(t)}/{state_slug(k)}/", MIN_COMBO):
                combos[(t, k)] = hit

    # A major whose listings are exactly a field page's, or an earlier major's, would be a second URL
    # for the same list. It gets no page of its own: the majors hub links it to that page, and that
    # page names it.
    owner = {frozenset(x["id"] for x in v): f"/internships/{field_slug(t)}/" for t, v in fields.items()}
    major_rows, fits = [], {}
    for m in d["majors"]:
        tags = [t for t in m.get("tags") or [] if t not in SKIP_FIELDS]
        items = [x for x in listings if set(x.get("field_tags") or []) & set(tags)]
        if (m.get("level") not in (None, "undergrad")
                or not enough(len(items), f"/internships/for/{slugify(m['name'])}-majors/")):
            continue
        name = m["name"]
        ids = frozenset(x["id"] for x in items)
        path = owner.setdefault(ids, f"/internships/for/{slugify(name)}-majors/")
        major_rows.append((m, tags, items, path))
        fits.setdefault(path, []).append(name)

    # Employers with enough open roles get a page ("Amgen internships" is a common search). Two
    # names that slug alike keep only the larger, so one URL never means two companies.
    global EMPLOYERS
    by_company: dict[str, list] = {}
    for x in listings:
        by_company.setdefault(x.get("company_name") or "", []).append(x)
    EMPLOYERS = {}
    taken: set[str] = set()
    for name, items in sorted(by_company.items(), key=lambda kv: -len(kv[1])):
        slug = slugify(name)
        path = f"/internships/at/{slug}/"
        if not slug or slug in taken or not enough(len(items), path, MIN_EMPLOYER):
            continue
        taken.add(slug)
        EMPLOYERS[name] = path

    def add(path, title, desc, h1, crumbs, body, items=None, state=None):
        # lastmod is the day the page's newest listing was found: it moves when the page gains a
        # listing, not on every deploy, which is the only lastmod a search engine keeps trusting.
        found = [str(x.get("first_seen") or "")[:10] for x in (listings if items is None else items)]
        pages.append({"path": path, "html": page(path, title, desc, h1, crumbs, body, updated, feed=items is not None),
                      "items": items, "h1": h1, "state": state,
                      "lastmod": max((f for f in found if f), default=None)})

    root = ("/internships/", "Internships")

    for t, items in sorted(fields.items()):
        name = field_title(t)
        path = f"/internships/{field_slug(t)}/"
        top_states = sorted(((k, len(v)) for (tt, k), v in combos.items() if tt == t), key=lambda kv: -kv[1])
        related = link_list(f"{name} internships by state",
                            [(f"{path}{state_slug(k)}/", US_STATES[k], n) for k, n in top_states])
        emp = join_words([c for c, _ in Counter(x["company_name"] for x in items).most_common(3)])
        add(path, f"{name} Internships – {len(items):,} Open Now | InternScout",
            f"{len(items):,} open {lower_name(name)} internships and co-ops for college students, updated "
            f"{updated}. Employers include {emp}. Free search, no sign-up.",
            f"{name} internships", [root, (path, name)],
            listing_body(items, f"in {lower_name(name)}", "", now, related, dash=dash_link([t]), fits=fits.get(path)), items)

    for k, items in sorted(states.items()):
        where = US_STATES[k]
        path = f"/internships/{state_slug(k)}/"
        top_fields = sorted(((t, len(v)) for (t, kk), v in combos.items() if kk == k), key=lambda tv: -tv[1])
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
        others = sorted(((kk, len(v)) for (tt, kk), v in combos.items() if tt == t and kk != k), key=lambda kv: -kv[1])
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

    for name, path in sorted(EMPLOYERS.items()):
        items = by_company[name]
        top = [t for t, _ in Counter(t for x in items for t in set(x.get("field_tags") or []) - SKIP_FIELDS).most_common(3)]
        mostly = join_words([lower_name(field_title(t)) for t in top])
        note = (f"<p class=\"more\">InternScout is not affiliated with {esc(name)}. These are its open roles "
                "from public job boards; always apply on the employer's own site.</p>")
        related = note + link_list("Related fields", [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t]))
                                                     for t in top if t in fields])
        add(path, f"{name} Internships – {len(items):,} Open Now | InternScout",
            f"{len(items):,} open internships and co-ops at {name} for college students"
            + (f", mostly in {mostly}" if mostly else "") + f". Updated {updated}. Free search, no sign-up.",
            f"Internships at {name}", [root, ("/internships/at/", "By employer"), (path, name)],
            listing_body(items, f"at {name}", "", now, related, dash=dash_link(search=name), here=name), items)

    new = [x for x in listings if fresh(x, now, d["baseline"])]
    if len(new) >= MIN_OPEN:
        add("/internships/new/", f"New Internships This Week – {len(new):,} Found | InternScout",
            f"{len(new):,} internships, co-ops and research roles for college students found in the last week, "
            f"Northeast and remote first. Updated {updated}. Free, no sign-up.",
            "New internships this week", [root, ("/internships/new/", "New this week")],
            listing_body(new, "found in the last week", "", now,
                         "<p class=\"more\">One feed for a whole club: this page's RSS feed carries every new "
                         "role, so a Discord or Slack channel can follow just this one.</p>"), new)

    # Hubs last, so they only link to pages that exist.
    add("/internships/at/", f"Internships by Employer – {len(EMPLOYERS):,} Employers | InternScout",
        f"Open internships and co-ops at {len(EMPLOYERS):,} employers hiring college students now, from each "
        "employer's public job board. Free, no sign-up.",
        "Internships by employer", [root, ("/internships/at/", "By employer")],
        f"<p class=\"lede\">Every employer with at least {MIN_EMPLOYER} open student roles. InternScout is not "
        "affiliated with any of them.</p>"
        + link_list("Employers", sorted(((p, n, len(by_company[n])) for n, p in EMPLOYERS.items()),
                                        key=lambda e: e[1].lower())))
    add("/internships/for/", f"Internships by Major – {len(majors_made)} Majors | InternScout",
        "Open internships, co-ops and research roles for every UMass Amherst major, from nursing and "
        "sport management to engineering and finance. Free, no sign-up.",
        "Internships by major", [root, ("/internships/for/", "By major")],
        "<p class=\"lede\">Pick your major to see open roles that fit it. Each page counts only what is "
        "open today.</p>" + link_list("Majors", sorted(majors_made, key=lambda p: p[1])))
    hub = (f"<p class=\"lede\">{len(listings):,} open internships, co-ops, research positions and "
           "fellowships for college students, collected from employer job boards and public programs. "
           "Browse by field, by state or by major, or open the dashboard to rank them for you.</p>"
           "<p>Every page below has an RSS feed of its new listings (the link at the bottom of the page). "
           "Paste it into a Discord feed bot such as MonitoRSS, or Slack's <code>/feed subscribe</code>, "
           "and new roles appear in your club's channel as they are found.</p>"
           "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
           + link_list("By field", sorted(((f"/internships/{field_slug(t)}/", field_title(t), len(v))
                                          for t, v in fields.items()), key=lambda p: p[1]))
           + link_list("By state", sorted(((f"/internships/{state_slug(k)}/", US_STATES[k], len(v))
                                          for k, v in states.items()), key=lambda p: p[1]))
           + "<section class=\"rel\"><h2>More ways to browse</h2><ul><li><a href=\"/internships/for/\">"
             f"All {len(majors_made)} majors</a></li><li><a href=\"/internships/at/\">All {len(EMPLOYERS):,} employers"
             "</a></li>" + (f"<li><a href=\"/internships/new/\">New this week</a> <span class=\"n\">{len(new):,}</span></li>"
                            if len(new) >= MIN_OPEN else "") + "</ul></section>")
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
    now = datetime.now(timezone.utc)
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
        f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
                f"Disallow: /data/\n\nSitemap: {SITE}/sitemap.xml\n")


def live_paths(sitemap: str) -> set[str]:
    """The paths in the sitemap the site was serving before this build; empty if there was none."""
    try:
        with open(sitemap, encoding="utf-8") as f:
            return {SITE_PATH.sub("", u) for u in re.findall(r"<loc>([^<]+)</loc>", f.read())}
    except OSError:
        return set()


SITE_PATH = re.compile("^" + re.escape(SITE))


def main(argv: list[str]) -> None:
    site_dir = argv[1] if len(argv) > 1 else "docs"
    pages = build(site_dir, live_paths(argv[2]) if len(argv) > 2 else set())
    write(site_dir, pages)
    from . import feeds            # feeds imports this module, so not at the top
    feeds.write_all(site_dir, pages)
    print(f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt into {site_dir}")


if __name__ == "__main__":
    main(sys.argv)
