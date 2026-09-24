"""The weekly new-internships email, written from the data. This builds the email; it never sends it.

Each week's digest covers the fields that gained at least MIN_NEW roles this week (new by the same
rule as /internships/new/), most new first, up to MAX_SECTIONS of them. Each field lists up to
PER_SECTION roles, Northeast and remote first, and links to the field's landing page. A subscriber
who picked fields gets only those. If none of their fields had MIN_NEW new roles, they get every
field rather than an empty email.

Nothing here sends mail or opens a network connection. Sending needs an email provider and a postal
address first. A sender would take the HTML and text from render_html and render_text, replace
{{ unsubscribe_url }} with the provider's own unsubscribe link, and pass in the postal address. The
subscriber list would live with that provider. InternScout's own servers never store an email address.
growth/digest_send.py is that sender, through Buttondown; this file stays unable to send.

Run from the repo root:  python growth/digest.py [docs] [--out DIR]
    writes digest.html, digest.txt and digest.json into DIR (default ./digest-preview).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
from internscout import seo_pages as sp  # noqa: E402

MIN_NEW = 3            # new roles a field needs this week to get a section
MAX_SECTIONS = 8       # eight fields of five roles is already a long email
PER_SECTION = 5        # roles shown per field; the field's page has the rest
PER_EMPLOYER = 2       # ...and at most this many from one employer, so one big poster can't fill a field

UTM = "utm_source=digest&utm_medium=email"
HOME_URL = f"{sp.SITE}/?{UTM}"
SLOGAN = "Built by one student, made for all students."
WHY = "You're getting this because you signed up for new-internship emails at internscout.org."
# The sender replaces this with the email provider's own unsubscribe link for each subscriber.
UNSUBSCRIBE = "{{ unsubscribe_url }}"
# CAN-SPAM requires a physical postal address in every commercial email. Until there is one (a PO box
# keeps a home address off it), the email shows this where the address goes, so no one misses it.
NO_ADDRESS = "[POSTAL ADDRESS REQUIRED BEFORE SENDING]"

# The site's palette (seo_pages.CSS), light only: many email clients ignore dark-mode styles.
INK, INK2, INK3 = "#17191c", "#454a52", "#646a73"
ACCENT, PAPER, RULE = "#1d5c46", "#f6f4ef", "#e2ded4"
SANS = "font-family:Helvetica,Arial,sans-serif"
SERIF = "font-family:Georgia,'Times New Roman',serif"

esc = html.escape
# The state slugs are shared with seo_pages.build, which gives a field no page when its slug names a state.
STATE_SLUGS = {sp.state_slug(k) for k in sp.US_STATES}


# ---------------------------------------------------------------- building

def _text(value) -> str:
    """Job-board text on one line. A title with a newline or tab in it would break the text email's layout."""
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _link(url) -> str | None:
    """A web link, or None. safe_url keeps only http(s). A link with whitespace inside is not a real
    address, and in the text email it would start a new line."""
    u = sp.safe_url(url)
    return u if u and not re.search(r"\s", u) else None


def unique_roles(items: list[dict]) -> list[dict]:
    """One row per role. dedupe_roles matches on title and place, so it runs within each employer:
    two companies that each post a "Software Engineering Intern" in Boston are two roles."""
    by_employer: dict[str, list[dict]] = {}
    for x in items:
        by_employer.setdefault(sp.employer_key(x.get("company_name") or ""), []).append(x)
    return [x for group in by_employer.values() for x in sp.dedupe_roles(group)]


def field_url(tag: str, open_count: int) -> str:
    """The field's landing page. When the field has no page, the dashboard filtered to that field
    instead. A page needs MIN_OPEN open roles, and a field whose slug names a state gets none."""
    slug = sp.field_slug(tag)
    if open_count >= sp.MIN_OPEN and slug not in STATE_SLUGS:
        return f"{sp.SITE}/internships/{slug}/?{UTM}"
    return f"{sp.SITE}/?field={quote(tag)}&{UTM}"


def role(x: dict) -> dict:
    pay = _text(x["salary"]) if x.get("salary") else ("Paid" if sp.is_paid(x) else None)
    return {"id": x.get("id"), "title": _text(x.get("title")), "company": _text(x.get("company_name")),
            "place": _text(sp.place(x)), "pay": pay, "url": _link(x.get("apply_url")),
            "nearby": bool(x["keys"] & sp.HOME_STATES)}


def section(tag: str, items: list[dict], open_count: int) -> dict:
    return {"tag": tag, "title": sp.field_title(tag), "new": len(items), "open": open_count,
            "url": field_url(tag, open_count),
            "roles": [role(x) for x in varied(sp.near_home_first(items))]}


def varied(ordered: list[dict]) -> list[dict]:
    """The first PER_SECTION roles in order, at most PER_EMPLOYER from any one employer. When too few
    employers are left to fill the section, the rest are filled in order after all."""
    seen: Counter = Counter()
    picked = []
    for x in ordered:
        if seen[x.get("company_name")] < PER_EMPLOYER:
            seen[x.get("company_name")] += 1
            picked.append(x)
        if len(picked) == PER_SECTION:
            return picked
    return picked + [x for x in ordered if x not in picked][:PER_SECTION - len(picked)]


def preheader(sections: list[dict]) -> str:
    """The line an inbox shows after the subject: which fields the email covers."""
    if not sections:
        return "The roles InternScout found this week, Northeast and remote first."
    names = ", ".join(s["title"] for s in sections[:3])
    return f"New this week in {names}{' and more' if len(sections) > 3 else ''}. Northeast and remote roles first."


def build(site_dir: str, now: datetime | None = None) -> dict:
    """This week's digest, from <site_dir>/data. now defaults to when the data was exported."""
    d = sp.load(site_dir)
    now = now or sp._when(d["generated_at"]) or datetime.now(timezone.utc)
    listings = d["listings"]
    new = unique_roles([x for x in listings if sp.fresh(x, now, d["baseline"])])
    # Open roles per field, counted as the field's landing page counts them, so "See all N" matches it.
    open_by_field = Counter(t for x in listings for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS)
    by_field: dict[str, list[dict]] = {}
    for x in new:
        for t in set(x.get("field_tags") or []) - sp.SKIP_FIELDS:
            by_field.setdefault(t, []).append(x)
    ranked = sorted(((t, v) for t, v in by_field.items() if len(v) >= MIN_NEW),
                    key=lambda tv: (-len(tv[1]), sp.field_title(tv[0])))
    sections = [section(t, v, open_by_field[t]) for t, v in ranked]
    return {
        "subject": f"{sp.plural(len(new), 'new internship')} this week",
        "preheader": preheader(sections[:MAX_SECTIONS]),
        "week_ending": f"{now:%B} {now.day}, {now.year}",
        "generated_at": now.isoformat(),
        # /internships/new/ is built only when it has MIN_OPEN roles; below that, the dashboard's new filter.
        "new_url": f"{sp.SITE}/internships/new/?{UTM}" if len(new) >= sp.MIN_OPEN else f"{sp.SITE}/?new=1&{UTM}",
        "totals": {"open": len(listings), "new": len(new),
                   "nearby": sum(1 for x in new if x["keys"] & sp.HOME_STATES), "fields": len(sections)},
        "sections": sections[:MAX_SECTIONS],
        # Fields past the cap. Everyone's email stops at MAX_SECTIONS, but a subscriber who picked one of
        # these fields still gets it (pick_sections).
        "more_sections": sections[MAX_SECTIONS:],
    }


# ---------------------------------------------------------------- rendering

def pick_sections(digest: dict, fields=None) -> tuple[list[dict], str]:
    """(sections, why) for one subscriber. fields are the field tags they picked. why is "picked" when
    the email shows only those, "fallback" when none of them had a section this week and it shows
    every field instead, and "" when they picked none."""
    if isinstance(fields, str):
        fields = fields.split(",")
    wanted = {str(f).strip() for f in fields or () if str(f).strip()}
    if not wanted:
        return digest["sections"], ""
    mine = [s for s in digest["sections"] + digest.get("more_sections", []) if s["tag"] in wanted]
    if mine:
        return mine[:MAX_SECTIONS], "picked"
    return digest["sections"], "fallback"


def intro(digest: dict, sections: list[dict]) -> str:
    t = digest["totals"]
    line = f"InternScout found {sp.plural(t['new'], 'new student role')} this week"
    if t["nearby"]:
        line += f", {t['nearby']:,} of them in the Northeast or remote."
        if sections:
            line += " In each field below, those come first."
    return line if line.endswith(".") else line + "."


def note(why: str) -> str:
    if why == "picked":
        return "Showing only the fields you picked."
    if why == "fallback":
        return (f"None of the fields you picked gained {MIN_NEW} or more new roles this week, "
                "so here are the fields that did.")
    return ""


def _address(postal_address) -> list[str] | None:
    lines = [_text(line) for line in str(postal_address or "").splitlines()]
    return [line for line in lines if line] or None


def affiliation() -> str:
    return ("InternScout is a free internship search made by a UMass Amherst student. It is not "
            "affiliated with UMass Amherst or with any employer listed here. These roles come from "
            "public job boards, so always check the posting on the employer's own site before applying.")


def _a(url, label: str, style: str) -> str:
    """A link, only when url is a web link; otherwise the label alone."""
    u = _link(url)
    return f'<a href="{esc(u)}" style="{style}">{esc(label)}</a>' if u else esc(label)


def _role_html(r: dict) -> str:
    meta = " · ".join(esc(_text(v)) for v in (r.get("place"), r.get("pay")) if _text(v))
    title = _a(r.get("url"), _text(r.get("title")), f"color:{ACCENT};text-decoration:underline")
    return (f'<tr><td style="padding:12px 0;border-top:1px solid {RULE};{SANS};font-size:15px;'
            f'line-height:1.45;color:{INK}">'
            f'<div style="font-weight:bold">{esc(_text(r.get("company")))}</div>'
            f'<div>{title}</div>'
            + (f'<div style="font-size:13px;color:{INK3}">{meta}</div>' if meta else "")
            + "</td></tr>")


def _section_html(s: dict) -> str:
    title = _text(s.get("title"))
    rows = "".join(_role_html(r) for r in s.get("roles") or [])
    more = _a(s.get("url"), f"See all {s.get('open', 0):,} open {sp.lower_name(title)} roles",
              f"color:{ACCENT};font-weight:bold;text-decoration:underline")
    return (f'<tr><td style="padding:30px 0 6px">'
            f'<h2 style="margin:0;{SERIF};font-size:21px;line-height:1.3;font-weight:bold;color:{INK}">{esc(title)}</h2>'
            f'<p style="margin:4px 0 0;{SANS};font-size:14px;color:{INK3}">{s.get("new", 0):,} new this week</p>'
            "</td></tr>"
            '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
            f"{rows}</table></td></tr>"
            f'<tr><td style="padding:10px 0 0;border-top:1px solid {RULE};{SANS};font-size:14px">{more}</td></tr>')


def render_html(digest: dict, fields=None, postal_address=None) -> str:
    """The email's HTML part: inline styles and tables only, the way email clients render it, 600px wide
    at most, with no stylesheets, scripts or images. Everything from a job board is escaped, and only
    http(s) links are emitted, except the {{ unsubscribe_url }} placeholder the sender fills in."""
    sections, why = pick_sections(digest, fields)
    pre = preheader(sections) if why == "picked" else digest.get("preheader", "")
    address = _address(postal_address)
    address_html = ("<br>".join(esc(line) for line in address) if address else
                    f'<strong style="color:#9b1c1c">{esc(NO_ADDRESS)}</strong>')
    extra = note(why)
    extra_html = (f'<p style="margin:12px 0 0;{SANS};font-size:15px;line-height:1.55;color:{INK2}">{esc(extra)}</p>'
                  if extra else "")
    new_url = _link(digest.get("new_url"))
    button = (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0">'
              f'<tr><td style="background:{ACCENT};border-radius:6px">'
              f'<a href="{esc(new_url)}" style="display:inline-block;padding:11px 18px;{SANS};font-size:15px;'
              f'font-weight:bold;color:{PAPER};text-decoration:none;border-radius:6px">See every new role</a>'
              "</td></tr></table>") if new_url else ""
    body = "".join(_section_html(s) for s in sections)
    subject = esc(_text(digest.get("subject")))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{subject}</title>
</head>
<body style="margin:0;padding:0;background:{PAPER}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:{PAPER};font-size:1px;line-height:1px">{esc(_text(pre))}{"&zwnj;&nbsp;" * 40}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{PAPER}">
<tr><td align="center" style="padding:0 16px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;{SANS};color:{INK}">
<tr><td style="padding:24px 0 14px;border-bottom:1px solid {INK}">{_a(HOME_URL, "InternScout", f"{SERIF};font-size:22px;font-weight:bold;color:{INK};text-decoration:none")}</td></tr>
<tr><td style="padding:24px 0 0">
<h1 style="margin:0;{SERIF};font-size:28px;line-height:1.2;font-weight:bold;color:{INK}">{subject}</h1>
<p style="margin:6px 0 0;{SANS};font-size:14px;color:{INK3}">Week ending {esc(_text(digest.get("week_ending")))}</p>
<p style="margin:14px 0 0;{SANS};font-size:16px;line-height:1.55;color:{INK2}">{esc(intro(digest, sections))}</p>
{extra_html}
{button}
</td></tr>
{body}
<tr><td style="padding:40px 0 32px">
<div style="border-top:1px solid {RULE};padding-top:16px;{SANS};font-size:13px;line-height:1.55;color:{INK3}">
<p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:{INK}">{esc(SLOGAN)}</p>
<p style="margin:0 0 8px">{esc(affiliation())}</p>
<p style="margin:0 0 8px">{esc(WHY)} <a href="{UNSUBSCRIBE}" style="color:{INK2};text-decoration:underline">Unsubscribe</a></p>
<p style="margin:0">{address_html}</p>
</div>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
"""


def render_text(digest: dict, fields=None, postal_address=None) -> str:
    """The email's plain-text part: the same content as render_html, with every link written out."""
    sections, why = pick_sections(digest, fields)
    new_url = _link(digest.get("new_url"))
    out = [_text(digest.get("subject")), f"Week ending {_text(digest.get('week_ending'))}", "",
           intro(digest, sections)]
    if why:
        out.append(note(why))
    if new_url:
        out += ["", f"See every new role: {new_url}"]
    for s in sections:
        title = _text(s.get("title"))
        head = f"{title}: {s.get('new', 0):,} new this week"
        out += ["", "", head, "-" * len(head)]
        for r in s.get("roles") or []:
            company = _text(r.get("company"))
            out += ["", f"* {_text(r.get('title'))}" + (f" at {company}" if company else "")]
            meta = " · ".join(_text(v) for v in (r.get("place"), r.get("pay")) if _text(v))
            if meta:
                out.append(f"  {meta}")
            if _link(r.get("url")):
                out.append(f"  {_link(r.get('url'))}")
        if _link(s.get("url")):
            out += ["", f"See all {s.get('open', 0):,} open {sp.lower_name(title)} roles: {_link(s.get('url'))}"]
    address = _address(postal_address)
    out += ["", "", "-" * 40, SLOGAN, "", affiliation(), "", WHY, f"Unsubscribe: {UNSUBSCRIBE}", ""]
    out += address or [NO_ADDRESS]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- command line

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="digest.py", description="Write a preview of this week's email digest.")
    ap.add_argument("site_dir", nargs="?", default="docs", help="a copy of docs/ (reads <site_dir>/data)")
    ap.add_argument("--out", default="digest-preview", help="folder for digest.html, digest.txt and digest.json")
    args = ap.parse_args(argv[1:])
    digest = build(args.site_dir)
    os.makedirs(args.out, exist_ok=True)
    for name, body in (("digest.html", render_html(digest)), ("digest.txt", render_text(digest)),
                       ("digest.json", json.dumps(digest, ensure_ascii=False, indent=1) + "\n")):
        with open(os.path.join(args.out, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
    t = digest["totals"]
    print(f"[digest] {digest['subject']}: {len(digest['sections'])} of {t['fields']} fields shown, "
          f"{t['nearby']:,} new roles in the Northeast or remote; wrote digest.html, digest.txt and "
          f"digest.json to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
