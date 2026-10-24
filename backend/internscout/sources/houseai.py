"""House AI (houseaiapp.com): one employer's own careers site, read the same way as UHN.

houseaiapp.com/careers lists Fall 2026 internships; each role page embeds a
schema.org JobPosting (title, HTML description, datePosted, validThrough,
employmentType, TELECOMMUTE location, workHours). The roles are unpaid with
academic-credit support; the Fall term runs August 10 - December 18, 2026 and
applications close October 31, 2026. The site's robots.txt allows public
crawling (Allow: /, only /api/ and /auth/ disallowed).

Added 2026-10-24 at the employer's request (Aashika Samson, Recruiting
Coordinator, aashika@houseaiapp.com); the reply to her promised the roles
would be listed as unpaid. The pipeline's pay classifier (insights.py) tags a
listing "unpaid" when its description says so, so the facts line below leads
with it. This is a free pipeline source, not a paid placement: House AI did
not go through employer checkout.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime

from .base import client
from .common import ScanCounts, board_item, html_to_text, report_source
from ..classify import is_internship

HUB_URL = "https://www.houseaiapp.com/careers"
SITE = "https://www.houseaiapp.com"
COMPANY = {"name": "House AI"}
# Fall 2026 batch facts, from the careers hub FAQ. The close date itself is
# read per role from its validThrough; this line covers term + credit support.
TERM_LINE = ("Fall term August 10 - December 18, 2026. "
             "Course credit supported (faculty sponsor forms, professor "
             "check-ins, end-of-term evaluations).")

_SLUG_RE = re.compile(r'href="/careers/([a-z0-9][a-z0-9-]*)"')
_SKIP_SLUGS = {"cities", "course-credit"}
_LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


def role_slugs(hub_html: str) -> list[str]:
    """Role slugs linked from the careers hub, in page order, deduped."""
    seen: set[str] = set()
    out: list[str] = []
    for slug in _SLUG_RE.findall(hub_html or ""):
        if slug in _SKIP_SLUGS or slug in seen:
            continue
        seen.add(slug)
        out.append(slug)
    return out


def _valid_through(value: str | None) -> date | None:
    try:
        return datetime.fromisoformat((value or "").strip()).date()
    except ValueError:
        return None


def parse_houseai_jobposting(jp: dict, today: date | None = None) -> dict | None:
    """One schema.org JobPosting -> a board item, or None to skip it."""
    today = today or date.today()
    if not isinstance(jp, dict) or jp.get("@type") != "JobPosting":
        return None
    title = (jp.get("title") or "").strip()
    emp_types = jp.get("employmentType") or []
    if isinstance(emp_types, str):
        emp_types = [emp_types]
    emp_types = [str(e).upper() for e in emp_types]
    if "INTERN" not in emp_types or not is_internship(title, "Intern Part-time"):
        return None
    closes = _valid_through(jp.get("validThrough"))
    if closes and closes < today:
        return None
    url = (jp.get("url") or "").strip()
    if not url:
        return None
    hours = (jp.get("workHours") or "20 hours per week").strip()
    facts = (f"Unpaid. {hours}. Fully remote (US or UK). {TERM_LINE}")
    if closes:
        facts += f" Applications close {closes.strftime('%B %d, %Y')}."
    description = " ".join(x for x in (facts, html_to_text(jp.get("description") or "")) if x)
    return board_item(COMPANY, source="houseai", title=title, locations=["Remote"],
                      url=url, apply_url=url.rstrip("/") + "/apply",
                      posted_at=(jp.get("datePosted") or "")[:10] or None,
                      description=description, employment_type="Intern Part-time")


def parse_houseai_page(page_html: str, today: date | None = None) -> dict | None:
    """Extract the JobPosting from one role page's JSON-LD, if any."""
    for raw in _LD_RE.findall(page_html or ""):
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        graph = data.get("@graph") if isinstance(data, dict) else None
        candidates = graph if isinstance(graph, list) else [data]
        for jp in candidates:
            item = parse_houseai_jobposting(jp, today)
            if item is not None:
                return item
    return None


def fetch_houseai(report=None) -> list[dict]:
    counts = ScanCounts()
    try:
        with client() as c:
            r = c.get(HUB_URL)
            r.raise_for_status()
            slugs = role_slugs(r.text)
            counts.rows(len(slugs))
            out: list[dict] = []
            for slug in slugs:
                try:
                    page = c.get(f"{SITE}/careers/{slug}")
                    page.raise_for_status()
                except Exception:
                    counts.discard("unreadable")
                    continue
                item = parse_houseai_page(page.text)
                if item is None:
                    counts.discard("not_student")
                    continue
                out.append(item)
    except Exception as e:
        print(f"[houseai] failed: {type(e).__name__}")
        report_source(report, "houseai", error=e)
        return []
    print(f"[houseai] {len(out)} student postings")
    report_source(report, "houseai", items=out, counts=counts)
    return out
