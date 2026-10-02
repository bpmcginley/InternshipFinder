"""The "Summer 2027 Internships — Every Major" list, a README for a public GitHub repository.

Added 2026-10-02. Students already watch GitHub lists of internships (a README of tables, one row per
role, kept up to date by a bot), but the well-known ones are tech only. This writes the same kind of
list for every major from InternScout's own data: a "New this week" table, then one table per field
(accounting, nursing, theater, ...), each showing its newest roles and linking to the field's landing
page for the rest. Every Apply link goes straight to the employer's posting, as on the site.

What it lists: the open roles whose posting names Summer 2027 as the start term (the title says so,
and a posting with no term may well be for some other season), that are internships, co-ops,
research or fellowships. A role posted on two of one employer's boards is one row (digest.unique_roles).

Everything is computed from docs/data through seo_pages, so the counts, the field pages linked and
the employer pages linked are the ones the site has. The file is dated from the export's day, never
the clock, and every order breaks its ties, so two runs on the same data write the same bytes and the
publishing workflow commits nothing. GitHub stops rendering a README at about 512 KB, so the README
shows as many rows per field as fit in README_BUDGET, and each field also gets fields/<slug>.md with
up to FILE_ROWS of its roles.

The workflow .github/workflows/every-major-list.yml runs this after each site deploy and pushes the
result to the list's own repository (REPO). This file never opens a network connection.

Run from the repo root:  python growth/every_major_list.py [docs] [--out DIR] [--live-sitemap FILE]
    writes DIR/README.md and DIR/fields/*.md (default DIR: ./every-major-list), and removes
    fields/*.md files left from fields that no longer have a section.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.path.insert(0, HERE)
from internscout import seo_pages as sp  # noqa: E402
import digest  # noqa: E402

TERM = "Summer 2027"
REPO = "bpmcginley/internships-every-major"     # where the workflow publishes the list
SOURCE = "https://github.com/bpmcginley/InternshipFinder/blob/main/growth/every_major_list.py"
SLOGAN = "Built by one student, made for all students."

MIN_FIELD = sp.MIN_OPEN          # Summer 2027 roles a field needs for a section of its own
README_ROWS = (40, 30, 25, 20, 15, 10, 5)    # rows per field in the README: the first that fits
README_BUDGET = 450_000          # bytes; GitHub stops rendering a file at about 512 KB
FILE_ROWS = 200                  # rows in each fields/<slug>.md
NEW_ROWS = 50                    # rows in "New this week"
TITLE_MAX = 120                  # a job board's title or company name can run to hundreds of characters
COMPANY_MAX = 80
PAY_MAX = 48

HEADER = "| Company | Role | Location | Pay | Posted | Apply |\n|---|---|---|---|---|---|"


# ---------------------------------------------------------------- markdown safety

# Characters that mean something inside a table cell or a link's text. A "|" ends the cell (GitHub
# reads it so even inside a link), brackets start a link, and <, > and & would let a company called
# "<img src=...>" put HTML in the README. Each is escaped, so job-board text only ever reads as text.
_MD_SPECIAL = re.compile(r"([\\|\[\]*_`~])")
# (A title with "www.example.com" in it is still turned into a link by GitHub's autolinking; that
# only links what the posting itself says, so it is left alone.)


def md(value, limit: int | None = None) -> str:
    """Job-board text as one safe line of a table cell (cut to `limit` characters first)."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if limit and len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    # Only an & that starts an entity ("&copy;") needs escaping; "AT&T" reads as itself.
    # Only an & that starts an entity ("&copy;") needs escaping; "AT&T" and "Oil & Gas" read as
    # themselves, and stay readable in the raw file.
    text = re.sub(r"&(?=#?\w+;)", "&amp;", text).replace("<", "&lt;").replace(">", "&gt;")
    return _MD_SPECIAL.sub(r"\\\1", text)


def md_url(url) -> str | None:
    """A link destination that can't break out of its link or its cell, or None for anything but a
    plain http(s) address (digest._link: no javascript:, no whitespace). The few characters that end
    a link or a cell are percent-encoded, which a web server reads as the same address."""
    u = digest._link(url)
    if not u:
        return None
    for ch, code in (("\\", "%5C"), ("|", "%7C"), ("(", "%28"), (")", "%29"), ("<", "%3C"), (">", "%3E")):
        u = u.replace(ch, code)
    return u


def anchor(heading: str, used: set[str]) -> str:
    """The id GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens, and -1, -2
    on a repeat."""
    base = re.sub(r"[^a-z0-9 _-]", "", heading.lower()).replace(" ", "-")
    a, n = base, 0
    while a in used:
        n += 1
        a = f"{base}-{n}"
    used.add(a)
    return a


# ---------------------------------------------------------------- data

def summer_role(x: dict) -> bool:
    stages = set(x.get("stage") or [])
    return x.get("term") == TERM and (not stages or bool(stages & sp.STUDENT_STAGES))


def collect(site_dir: str, live: dict[str, str] | None = None) -> dict:
    """Everything the list says, from the site's data. live: the sitemap the site serves now
    (seo_pages.live_paths), so the field pages linked are exactly the ones deployed."""
    pages = sp.build(site_dir, live or {})       # sets sp.EMPLOYERS and sp.BASELINE too
    by_path = {p["path"]: p for p in pages}
    d = sp.load(site_dir)
    now = sp._when(d["generated_at"]) or datetime.now(timezone.utc)
    roles = sp.newest_first(digest.unique_roles([x for x in d["listings"] if summer_role(x)]))
    by_field: dict[str, list[dict]] = {}
    for x in roles:
        for t in sorted(set(x.get("field_tags") or []) - sp.SKIP_FIELDS):
            by_field.setdefault(t, []).append(x)
    fields = {t: v for t, v in by_field.items() if len(v) >= MIN_FIELD}
    open_by_field = Counter(t for x in d["listings"] for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS)
    links = {}
    for t in fields:
        page = by_path.get(f"/internships/{sp.field_slug(t)}/")
        # Only if that path is the field's own page: a field whose slug is a state's ("georgia") gets
        # none, and the page there is the state's (state is set on state pages, and h1 names the field).
        if page and (page.get("state") is not None or page.get("h1") != f"{sp.field_title(t)} internships"):
            page = None
        # The field's landing page and the count in its title; the dashboard filtered to the field
        # when the site has no page for it (a field page needs MIN_OPEN open roles, of any term).
        links[t] = ((sp.SITE + page["path"], len(page["items"])) if page else
                    (f"{sp.SITE}/?field={quote(t)}", open_by_field[t]))
    new = [x for x in roles if sp.fresh(x, now, d["baseline"])]
    return {"now": now, "roles": roles, "fields": fields, "links": links, "new": new,
            "total": len(d["listings"]), "employers": dict(sp.EMPLOYERS),
            "new_page": "/internships/new/" in by_path,
            "employer_count": len({sp.employer_key(x.get("company_name") or "") for x in roles})}


# ---------------------------------------------------------------- rendering

def posted(x: dict, now: datetime) -> str:
    """The day on the posting, or the day InternScout first found it when the posting gives none."""
    d = sp._when(x.get("posted_at")) or sp._when(x.get("first_seen"))
    if not d:
        return ""
    return f"{d:%b} {d.day}" if d.year == now.year else f"{d:%b} {d.day}, {d.year}"


def row(x: dict, ctx: dict) -> str | None:
    url = md_url(x.get("apply_url"))
    if not url:
        return None
    name = x.get("company_name") or ""
    company = md(name, COMPANY_MAX)
    page = ctx["employers"].get(name)
    if page and company:
        company = f"[{company}]({sp.SITE}{page})"     # the employer's page on InternScout
    cells = [company, md(x.get("title"), TITLE_MAX), md(sp.place(x)), md(sp.pay_text(x), PAY_MAX),
             posted(x, ctx["now"]), f"[Apply]({url})"]
    return "| " + " | ".join(cells) + " |"


def table(items: list[dict], ctx: dict, limit: int) -> str:
    rows = [r for r in (row(x, ctx) for x in items) if r][:limit]
    return HEADER + "\n" + "\n".join(rows)


def updated(ctx: dict) -> str:
    now = ctx["now"]
    return f"{now:%B} {now.day}, {now.year}"


def see_all(t: str, ctx: dict) -> str:
    url, n = ctx["links"][t]
    return f"[See all {n:,} {sp.lower_name(sp.field_title(t))} internships on InternScout]({url})"


def field_order(ctx: dict) -> list[str]:
    return sorted(ctx["fields"], key=lambda t: (sp.field_title(t).lower(), t))


def footer(ctx: dict, repo: str) -> str:
    return (
        "## About this list\n\n"
        "- **How it's made.** [InternScout](https://internscout.org) reads employers' own job boards "
        "(Workday, Greenhouse, Lever, iCIMS, Ashby, Oracle and others) several times a day, following each "
        "site's robots.txt. After each update this list is rebuilt from that data by "
        f"[`growth/every_major_list.py`]({SOURCE}). A role is listed here when its posting names {TERM} as "
        "its start term; other terms, and postings that don't give one, are on "
        "[internscout.org](https://internscout.org).\n"
        "- **The columns.** Pay is what the posting lists: \"Paid\" means it says it is paid without giving "
        "a rate, and a blank means it doesn't say. Posted is the date on the posting, or the day InternScout "
        "first found it when the posting has none. A role in several fields is listed in each.\n"
        f"- **Report a bad listing.** [Open an issue](https://github.com/{repo}/issues/new) with the company "
        "and the role: a broken link, a role that isn't for students, a wrong field. Closed postings drop "
        "off at the next update by themselves.\n"
        "- **Applying to a few?** The free [InternScout Auto-Apply](https://internscout.org/install.html?from=github-list) "
        "Chrome extension fills in applications with AI and never submits: you review every answer and "
        "press submit yourself.\n"
        "- Not affiliated with UMass Amherst, or with any employer listed. Always check the posting on the "
        "employer's site before applying.\n\n"
        f"**{SLOGAN}**\n")


def render(ctx: dict, per_field: int, repo: str = REPO) -> str:
    order = field_order(ctx)
    used: set[str] = {"contents", "new-this-week", "about-this-list"}
    anchors = {t: anchor(sp.field_title(t), used) for t in order}
    span = (f": {len(order)} fields from {sp.lower_name(sp.field_title(order[0]))} to "
            f"{sp.lower_name(sp.field_title(order[-1]))}," if len(order) > 1 else ",")
    out = [
        f"# {TERM} Internships — Every Major\n",
        "<!-- Generated by growth/every_major_list.py in bpmcginley/InternshipFinder. Edits here are "
        "overwritten at the next update. -->\n",
        f"A free, automatically updated list of **{len(ctx['roles']):,} open {TERM} internships, co-ops and "
        f"research roles** for college students in every major, not only tech{span} at "
        f"{ctx['employer_count']:,} employers in the US and Canada. It is rebuilt from "
        "[InternScout](https://internscout.org)'s data several times a day, straight from employers' own job "
        f"boards, and every Apply link goes to the employer's posting. **{SLOGAN}** Not affiliated with "
        "UMass Amherst.\n",
        f"**Updated {updated(ctx)}.** Other start terms, or roles near you? "
        f"[Search all {ctx['total']:,} open roles on InternScout](https://internscout.org), free, no account.\n",
        "## Contents\n",
        f"- [New this week](#new-this-week) ({len(ctx['new']):,})\n- [About this list](#about-this-list)\n",
        f"| Field | {TERM} roles | Full list |\n|---|---:|---|",
    ]
    out += [f"| [{sp.field_title(t)}](#{anchors[t]}) | {len(ctx['fields'][t]):,} | "
            f"[fields/{sp.field_slug(t)}.md](fields/{sp.field_slug(t)}.md) |" for t in order]
    out.append("")
    out.append("## New this week\n")
    new = ctx["new"]
    more = (f" [Every role found this week, of any start term]({sp.SITE}/internships/new/)."
            if ctx["new_page"] else "")
    if new:
        shown = min(len(new), NEW_ROWS)
        out.append(f"{len(new):,} {TERM} {'role' if len(new) == 1 else 'roles'} found in the last 7 days"
                   + (f"; the {shown} newest are below." if len(new) > shown else ".") + more + "\n")
        out.append(table(new, ctx, NEW_ROWS) + "\n")
    else:
        out.append(f"No new {TERM} roles were found in the last 7 days." + more + "\n")
    for t in order:
        items = ctx["fields"][t]
        n = len(items)
        slug = sp.field_slug(t)
        whole = "all of them" if n <= FILE_ROWS else f"the newest {FILE_ROWS}"
        shown = ("all of them below" if n <= per_field else f"the {per_field} newest below")
        out.append(f"## {sp.field_title(t)}\n")
        out.append(f"{n:,} {TERM} {'role' if n == 1 else 'roles'}, {shown}. "
                   f"[One page with {whole}](fields/{slug}.md) · {see_all(t, ctx)}\n")
        out.append(table(items, ctx, per_field) + "\n")
        out.append("[Back to contents](#contents)\n")
    out.append(footer(ctx, repo))
    return "\n".join(out)


def render_field(t: str, ctx: dict, repo: str = REPO) -> str:
    items = ctx["fields"][t]
    n = len(items)
    title = sp.field_title(t)
    shown = f"all {n:,}" if n <= FILE_ROWS else f"the {FILE_ROWS} newest of {n:,}"
    return "\n".join([
        f"# {title}: {TERM} Internships\n",
        f"{n:,} open {TERM} {sp.lower_name(title)} {'role' if n == 1 else 'roles'}, newest first ({shown}). "
        f"**Updated {updated(ctx)}.** [Back to every major](../README.md) · {see_all(t, ctx)}\n",
        table(items, ctx, FILE_ROWS) + "\n",
        f"Every Apply link goes to the employer's own posting; always check it there before applying. "
        f"[Report a bad listing](https://github.com/{repo}/issues/new). Not affiliated with UMass Amherst, "
        "or with any employer listed.\n",
        f"**{SLOGAN}**\n",
    ])


def build(site_dir: str, live: dict[str, str] | None = None, repo: str = REPO) -> dict[str, str]:
    """{relative path: content} for the README and every field's file."""
    ctx = collect(site_dir, live)
    if not ctx["fields"]:
        raise SystemExit(f"[list] no field has {MIN_FIELD} open {TERM} roles; refusing to write an empty list")
    readme = ""
    for per_field in README_ROWS:
        readme = render(ctx, per_field, repo)
        if len(readme.encode("utf-8")) <= README_BUDGET:
            break
    files = {"README.md": readme}
    files.update({f"fields/{sp.field_slug(t)}.md": render_field(t, ctx, repo) for t in ctx["fields"]})
    return files


def write(out_dir: str, files: dict[str, str]) -> None:
    """Write the files, and remove fields/*.md left from a field that no longer has a section, so the
    repository never keeps a stale page. Nothing else in out_dir (LICENSE, .git) is touched."""
    fields_dir = os.path.join(out_dir, "fields")
    os.makedirs(fields_dir, exist_ok=True)
    keep = {os.path.basename(p) for p in files if p.startswith("fields/")}
    for name in sorted(os.listdir(fields_dir)):
        if name.endswith(".md") and name not in keep:
            os.remove(os.path.join(fields_dir, name))
    for rel, text in files.items():
        with open(os.path.join(out_dir, *rel.split("/")), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("site", nargs="?", default="docs", help="the site folder (reads <site>/data)")
    ap.add_argument("--out", default="every-major-list")
    ap.add_argument("--live-sitemap", help="the sitemap the site serves now, so the links match it")
    ap.add_argument("--repo", default=REPO, help="owner/name of the list's repository, for the issues link")
    args = ap.parse_args(argv[1:])
    live = sp.live_paths(args.live_sitemap) if args.live_sitemap else {}
    files = build(args.site, live, args.repo)
    write(args.out, files)
    size = len(files["README.md"].encode("utf-8"))
    print(f"[list] wrote README.md ({size:,} bytes) and {len(files) - 1} field files into {args.out}")


if __name__ == "__main__":
    main(sys.argv)
