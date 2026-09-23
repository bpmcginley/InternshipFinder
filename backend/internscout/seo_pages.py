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
    return {"generated_at": index.get("generated_at"), "listings": list(by_id.values()),
            "majors": majors.get("majors", [])}


def _when(stamp) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def newest_first(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda x: (x.get("first_seen") or "", x.get("posted_at") or ""), reverse=True)


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


def near_home_first(items: list[dict]) -> list[dict]:
    ordered = newest_first(items)
    return [x for x in ordered if x["keys"] & HOME_STATES] + [x for x in ordered if not x["keys"] & HOME_STATES]


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


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
    terms = Counter(x["term"] for x in items if x.get("term"))
    if terms:
        top = [t for t, _ in terms.most_common(2)]
        parts.append(f"The most common start {'term is' if len(top) == 1 else 'terms are'} {join_words(top)}.")
    employers = [c for c, _ in Counter(x["company_name"] for x in items).most_common(5)]
    if len(employers) >= 3:
        parts.append(f"Employers with the most openings: {join_words(employers)}.")
    return " ".join(esc(p) for p in parts)


def listing_rows(items: list[dict], now: datetime, state: str | None = None) -> str:
    rows = []
    ordered = newest_first(items) if state else near_home_first(items)
    for x in ordered[:PER_PAGE]:
        seen = _when(x.get("first_seen"))
        new = seen and now - seen <= timedelta(days=NEW_DAYS)
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
            f'<div class="co">{esc(x.get("company_name") or "")}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{" · ".join(meta)}{pay_tag}</div>'
            f'<a class="go" href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>'
            "</li>")
    return "\n".join(rows)


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
.more{color:var(--ink2)}section.rel h2{font:600 20px/1.3 "Source Serif 4",Georgia,serif;margin:36px 0 8px}
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


def page(path: str, title: str, description: str, h1: str, crumbs: list[tuple[str, str]],
         body: str, updated: str) -> str:
    url = SITE + path
    crumb_html = " › ".join(f"<a href=\"{esc(h)}\">{esc(t)}</a>" for h, t in crumbs[:-1]) + \
                 (f" › {esc(crumbs[-1][1])}" if crumbs else "")
    ld = {"@context": "https://schema.org", "@type": "BreadcrumbList",
          "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": t, "item": SITE + h}
                              for i, (h, t) in enumerate(crumbs)]}
    # "</" inside a script block would end it early; JSON allows the escaped form.
    ld_json = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}"/>
<link rel="canonical" href="{esc(url)}"/>
<meta property="og:title" content="{esc(title)}"/>
<meta property="og:description" content="{esc(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{esc(url)}"/>
<meta property="og:image" content="{SITE}/og-preview.png"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="icon" type="image/png" sizes="48x48" href="/icon48.png"/>
<link rel="apple-touch-icon" href="/icon128.png"/>
<style>{CSS}</style>
<script type="application/ld+json">{ld_json}</script>
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
<footer>InternScout is a free internship search made by a UMass Amherst student. Not affiliated with UMass Amherst. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</div>
{BEACON}
</body>
</html>
"""


def dash_link(fields=(), state: str | None = None) -> str:
    """The dashboard, opened on this page's fields and state (docs/js/app.js reads ?field= and
    ?state=; the dashboard's canonical link keeps these one page to search engines)."""
    q = [f"field={quote(','.join(fields), safe=',')}"] if fields else []
    if state:
        q.append(f"state={quote(state)}")
    return "/?" + "&amp;".join(q) if q else "/"


def listing_body(items: list[dict], what: str, where: str, now: datetime, related: str,
                 state: str | None = None, dash: str = "/") -> str:
    more = len(items) - PER_PAGE
    order = "newest" if state else "newest, Northeast and remote first,"
    return (f"<p class=\"lede\">{summary(items, what, where)}</p>"
            f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
            f"<ul class=\"jobs\">{listing_rows(items, now, state)}</ul>"
            + (f"<p class=\"more\">Showing the {PER_PAGE} {order} of {len(items):,}. "
               f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>" if more > 0 else "")
            + related)


# ---------------------------------------------------------------- build

def build(site_dir: str) -> list[dict]:
    global BEACON
    BEACON = beacon_from(site_dir)
    d = load(site_dir)
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
    fields = {t: v for t, v in by_field.items() if len(v) >= MIN_OPEN}
    states = {k: v for k, v in by_state.items() if len(v) >= MIN_OPEN}
    # A field slug and a state slug must never name the same folder.
    state_slugs = {state_slug(k) for k in states}
    fields = {t: v for t, v in fields.items() if field_slug(t) not in state_slugs}

    combos: dict[tuple[str, str], list] = {}
    for t, items in fields.items():
        for k in states:
            hit = [x for x in items if k in x["keys"]]
            if len(hit) >= MIN_OPEN:
                combos[(t, k)] = hit

    def add(path, title, desc, h1, crumbs, body):
        pages.append({"path": path, "html": page(path, title, desc, h1, crumbs, body, updated)})

    root = ("/internships/", "Internships")

    for t, items in sorted(fields.items()):
        name = field_title(t)
        path = f"/internships/{field_slug(t)}/"
        top_states = sorted(((k, len(v)) for (tt, k), v in combos.items() if tt == t), key=lambda kv: -kv[1])
        related = link_list(f"{name} internships by state",
                            [(f"{path}{state_slug(k)}/", US_STATES[k], n) for k, n in top_states[:RELATED]])
        emp = join_words([c for c, _ in Counter(x["company_name"] for x in items).most_common(3)])
        add(path, f"{name} Internships – {len(items):,} Open Now | InternScout",
            f"{len(items):,} open {name.lower()} internships and co-ops for college students, updated "
            f"{updated}. Employers include {emp}. Free search, no sign-up.",
            f"{name} internships", [root, (path, name)],
            listing_body(items, f"in {name.lower()}", "", now, related, dash=dash_link([t])))

    for k, items in sorted(states.items()):
        where = US_STATES[k]
        path = f"/internships/{state_slug(k)}/"
        top_fields = sorted(((t, len(v)) for (t, kk), v in combos.items() if kk == k), key=lambda tv: -tv[1])
        related = link_list(f"Internships in {where} by field",
                            [(f"/internships/{field_slug(t)}/{state_slug(k)}/", field_title(t), n)
                             for t, n in top_fields[:RELATED]])
        loc = "remote" if k == "remote" else f"in {where}"
        add(path, f"Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout",
            f"{len(items):,} open internships, co-ops and research roles {loc}, updated {updated}. "
            "Free search for college students, no sign-up.",
            f"Internships {'you can do remotely' if k == 'remote' else 'in ' + where}", [root, (path, where)],
            listing_body(items, "", f" {loc}", now, related, state=k, dash=dash_link(state=k)))

    for (t, k), items in sorted(combos.items()):
        name, where = field_title(t), US_STATES[k]
        path = f"/internships/{field_slug(t)}/{state_slug(k)}/"
        others = sorted(((kk, len(v)) for (tt, kk), v in combos.items() if tt == t and kk != k), key=lambda kv: -kv[1])
        related = link_list(f"{name} internships in other states",
                            [(f"/internships/{field_slug(t)}/{state_slug(kk)}/", US_STATES[kk], n)
                             for kk, n in others[:RELATED]])
        loc = "remote" if k == "remote" else f"in {where}"
        add(path, f"{name} Internships {'(Remote)' if k == 'remote' else 'in ' + where} – {len(items):,} Open | InternScout",
            f"{len(items):,} open {name.lower()} internships and co-ops {loc}, updated {updated}. "
            "Free search for college students, no sign-up.",
            f"{name} internships {loc}",
            [root, (f"/internships/{field_slug(t)}/", name), (path, where)],
            listing_body(items, f"in {name.lower()}", f" {loc}", now, related, state=k, dash=dash_link([t], k)))

    majors_made = []
    for m in d["majors"]:
        tags = [t for t in m.get("tags") or [] if t not in SKIP_FIELDS]
        items = [x for x in listings if set(x.get("field_tags") or []) & set(tags)]
        if len(items) < MIN_OPEN or m.get("level") not in (None, "undergrad"):
            continue
        name = m["name"]
        path = f"/internships/for/{slugify(name)}-majors/"
        rel_tags = [t for t in (m.get("related") or []) if t in fields]
        related = link_list(f"Related fields for {name} majors",
                            [(f"/internships/{field_slug(t)}/", field_title(t), len(fields[t])) for t in rel_tags[:RELATED]])
        add(path, f"Internships for {name} Majors – {len(items):,} Open | InternScout",
            f"{len(items):,} open internships, co-ops and research roles that fit {name} majors, updated "
            f"{updated}. Built for UMass Amherst students; free, no sign-up.",
            f"Internships for {name} majors",
            [root, ("/internships/for/", "By major"), (path, name)],
            listing_body(items, f"that fit {name} majors", "", now, related, dash=dash_link(tags)))
        majors_made.append((path, name, len(items)))

    # Hubs last, so they only link to pages that exist.
    add("/internships/for/", f"Internships by Major – {len(majors_made)} Majors | InternScout",
        "Open internships, co-ops and research roles for every UMass Amherst major, from nursing and "
        "sport management to engineering and finance. Free, no sign-up.",
        "Internships by major", [root, ("/internships/for/", "By major")],
        "<p class=\"lede\">Pick your major to see open roles that fit it. Each page counts only what is "
        "open today.</p>" + link_list("Majors", sorted(majors_made, key=lambda p: p[1])))
    hub = (f"<p class=\"lede\">{len(listings):,} open internships, co-ops, research positions and "
           "fellowships for college students, collected from employer job boards and public programs. "
           "Browse by field, by state or by major, or open the dashboard to rank them for you.</p>"
           "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
           + link_list("By field", sorted(((f"/internships/{field_slug(t)}/", field_title(t), len(v))
                                          for t, v in fields.items()), key=lambda p: p[1]))
           + link_list("By state", sorted(((f"/internships/{state_slug(k)}/", US_STATES[k], len(v))
                                          for k, v in states.items()), key=lambda p: p[1]))
           + "<section class=\"rel\"><h2>By major</h2><ul><li><a href=\"/internships/for/\">"
             f"All {len(majors_made)} majors</a></li></ul></section>")
    add("/internships/", f"Browse {len(listings):,} Open Internships by Field, State and Major | InternScout",
        f"{len(listings):,} open internships, co-ops and research roles for college students, updated "
        f"{updated}. Browse by field, state or major. Free, no sign-up.",
        "Browse internships", [root], hub)
    return pages


def write(site_dir: str, pages: list[dict]) -> None:
    for p in pages:
        folder = os.path.join(site_dir, p["path"].strip("/").replace("/", os.sep))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "index.html"), "w", encoding="utf-8", newline="\n") as f:
            f.write(p["html"])
    today = datetime.now(timezone.utc).date().isoformat()
    static = ["/", "/install.html", "/privacy", "/terms"]
    urls = static + [p["path"] for p in pages]
    with open(os.path.join(site_dir, "sitemap.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            f.write(f"  <url><loc>{esc(SITE + u)}</loc><lastmod>{today}</lastmod></url>\n")
        f.write("</urlset>\n")
    with open(os.path.join(site_dir, "robots.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("User-agent: *\nAllow: /\n# Raw listing data; the pages under /internships/ are the readable form.\n"
                f"Disallow: /data/\n\nSitemap: {SITE}/sitemap.xml\n")


def main(argv: list[str]) -> None:
    site_dir = argv[1] if len(argv) > 1 else "docs"
    pages = build(site_dir)
    write(site_dir, pages)
    print(f"[seo] wrote {len(pages)} pages, sitemap.xml and robots.txt into {site_dir}")


if __name__ == "__main__":
    main(sys.argv)
