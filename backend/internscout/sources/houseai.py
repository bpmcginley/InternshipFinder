"""House AI (houseaiapp.com): one employer's own careers site, read the same way as UHN.

Each role page embeds a schema.org JobPosting with the current eligibility,
term, and deadline. Only roles explicitly open to U.S. or Canadian applicants
belong in the North American catalog. This is a free pipeline source.
"""

from __future__ import annotations
import logging

import json
import re
from datetime import date, datetime
from urllib.parse import urlsplit

from .base import client
from ..console_log import console, console_exception
from .common import ScanCounts, board_item, html_to_text, report_source
from ..classify import is_internship

HUB_URL = "https://www.houseaiapp.com/careers"
SITE = "https://www.houseaiapp.com"
COMPANY = {"name": "House AI"}
_SLUG_RE = re.compile(r'href="/careers/([a-z0-9][a-z0-9-]*)"')
_SKIP_SLUGS = {"cities", "course-credit", "search"}
_LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
_COUNTRY_ALIASES = {
    "us": "United States",
    "usa": "United States",
    "united states": "United States",
    "united states of america": "United States",
    "ca": "Canada",
    "can": "Canada",
    "canada": "Canada",
    "uk": "United Kingdom",
    "gb": "United Kingdom",
}


def is_houseai_role_url(url: str | None) -> bool:
    try:
        parts = urlsplit(url or "")
        return parts.hostname in {"houseaiapp.com", "www.houseaiapp.com"} and bool(
            re.fullmatch(r"/careers/[a-z0-9][a-z0-9-]*(?:/apply)?/?", parts.path)
        )
    except ValueError:
        return False


def _countries(requirements) -> list[str]:
    entries = requirements if isinstance(requirements, list) else [requirements]
    names = {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("@type") == "Country":
            name = entry.get("name")
            if isinstance(name, str) and (name := name.strip()):
                names.setdefault(name.casefold(), name)
    return list(dict.fromkeys(_COUNTRY_ALIASES.get(key, name) for key, name in names.items()))


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


def _valid_through(value: str | None) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.strip())
    except ValueError:
        return None


def _deadline_passed(closes: datetime, today: date | None) -> bool:
    if today is not None:
        return closes.date() < today
    if closes.tzinfo is not None:
        return closes < datetime.now(closes.tzinfo)
    return closes.date() < date.today()


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_houseai_jobposting(jp: dict, today: date | None = None) -> dict | None:
    """One schema.org JobPosting -> a board item, or None to skip it."""
    if not isinstance(jp, dict) or jp.get("@type") != "JobPosting":
        return None
    title = _text(jp.get("title"))
    emp_types = jp.get("employmentType") or []
    if isinstance(emp_types, str):
        emp_types = [emp_types]
    if not isinstance(emp_types, list):
        return None
    emp_types = [str(e).upper() for e in emp_types]
    if "INTERN" not in emp_types or not is_internship(title, "Intern Part-time"):
        return None
    closes = _valid_through(jp.get("validThrough"))
    if closes and _deadline_passed(closes, today):
        return None
    if jp.get("jobLocationType") != "TELECOMMUTE":
        return None
    countries = _countries(jp.get("applicantLocationRequirements"))
    locations = [
        f"Remote - {country}" for country in ("United States", "Canada") if country in countries
    ]
    if not locations:
        return None
    url = _text(jp.get("url"))
    if not is_houseai_role_url(url):
        return None
    path = urlsplit(url).path.rstrip("/").removesuffix("/apply")
    url = f"{SITE}{path}"
    hours = _text(jp.get("workHours"))
    facts = f"Remote eligibility: {', '.join(countries)}."
    if hours:
        facts += f" {hours.rstrip('.')}."
    if closes:
        facts += f" Applications close {closes.strftime('%B %d, %Y')}."
    description = " ".join(x for x in (facts, html_to_text(_text(jp.get("description")))) if x)
    return board_item(
        COMPANY,
        source="houseai",
        title=title,
        locations=locations,
        url=url,
        apply_url=url + "/apply",
        posted_at=_text(jp.get("datePosted"))[:10] or None,
        description=description,
        employment_type="Intern Part-time" if "PART_TIME" in emp_types else "Intern",
    )


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
                except Exception as e:
                    console_exception("[houseai] job detail failed", type(e).__name__)
                    counts.discard("unreadable")
                    continue
                item = parse_houseai_page(page.text)
                if item is None:
                    counts.discard("not_student")
                    continue
                out.append(item)
    except Exception as e:
        console(
            f"[houseai] failed: {type(e).__name__}",
            level=logging.WARNING,
            exception_type=type(e).__name__,
        )
        report_source(report, "houseai", error=e)
        return []
    console(f"[houseai] {len(out)} student postings")
    report_source(report, "houseai", items=out, counts=counts)
    return out
