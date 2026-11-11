"""Read the static listing export and share its selection rules."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from collections.abc import Callable, Collection, Mapping
from datetime import datetime, timezone

from ..console_log import console
from ..pay import placeholder_pay
from ..public_data import public_data_dir
from .taxonomy import CA_METRO_PAGES, us_metro
from .text import safe_url


_TEXT = (str, type(None))


_LIST_FIELDS = ("field_tags", "stage", "years")


FIRST_SEEN_SINCE = "2026-09-18"


CANADA_SINCE = "2026-09-30"


NEW_DAYS = 7


HOME_STATES = {"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "remote"}


PER_PAGE = 40  # listings shown on one page; the dashboard has the rest


_SUFFIX = re.compile(
    r"\s+(inc|incorporated|llc|ltd|co|company|corp|corporation|international|group|holdings|plc|lp)$"
)


EMPLOYER_ALIASES = {"booz allen hamilton": "booz allen"}


_NOT_A_NAME = frozenset(
    {
        "apply",
        "now",
        "here",
        "click",
        "today",
        "view",
        "see",
        "more",
        "details",
        "learn",
        "hiring",
        "job",
        "jobs",
        "career",
        "careers",
        "opening",
        "openings",
        "position",
        "positions",
        "confidential",
        "undisclosed",
        "unknown",
        "n",
        "a",
        "na",
        "tbd",
        "company",
        "name",
        "employer",
        "various",
        "multiple",
        "not",
        "specified",
    }
)


def well_formed(x) -> bool:
    """Whether a listing has the shape every page builder reads without checking. pages.yml deploys
    through this build and nothing else, so one row a job board mangled (a region with no "loc", a
    company name that is a number, a tag list that is a string) used to stop the whole site from
    deploying. Such a row is left out and counted instead (load)."""
    if (
        not isinstance(x, dict)
        or isinstance(x.get("id"), bool)
        or not isinstance(x.get("id"), (str, int))
    ):
        return False
    if not all(
        isinstance(x.get(k), _TEXT) for k in ("company_name", "title", "first_seen", "posted_at")
    ):
        return False
    if not isinstance(x.get("term"), _TEXT) or not isinstance(
        x.get("insights"), (dict, type(None))
    ):
        return False
    if not all(
        isinstance(x.get(k) or [], list) and all(isinstance(v, str) for v in x.get(k) or [])
        for k in _LIST_FIELDS
    ):
        return False
    regions = x.get("regions") or []
    return isinstance(regions, list) and all(
        isinstance(g, dict)
        and isinstance(g.get("loc"), _TEXT)
        and isinstance(g.get("state"), _TEXT)
        and bool(g.get("loc") or g.get("state"))
        for g in regions
    )


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
    return sorted(
        sorted(items, key=lambda x: str(x.get("id"))),
        key=lambda x: (
            bool(x.get("posted_at")),
            x.get("posted_at") or "",
            x.get("first_seen") or "",
        ),
        reverse=True,
    )  # sorted() stays stable under reverse=True, so ties keep id order


def place(x: dict, state: str | None = None) -> str:
    """Where the role is. On a state's page, the location in that state comes first: a Massachusetts
    page that says "New York, NY +5" reads as a listing filed in the wrong place."""
    regions = x.get("regions") or []
    if not regions:
        return "Remote" if x.get("is_remote") else "United States"
    if state == "remote":
        lead = next(
            (g for g in regions if g.get("kind") == "remote" or g.get("state") == "Remote"),
            regions[0],
        )
    elif state:
        # was: g.get("state") == state. A metro page leads with the location in that metro, and the
        # Canada page with the Canadian one.
        lead = next(
            (
                g
                for g in regions
                if g.get("state") == state
                or g.get("metro") == state
                or (state == "Canada" and g.get("kind") == "canada")
            ),
            regions[0],
        )
    else:
        lead = regions[0]
    shown = (
        "Remote"
        if lead.get("state") == "Remote"
        else (lead.get("loc") or lead.get("state") or "United States")
    )
    # was: shown = "Remote" if lead.get("state") == "Remote" else lead["loc"]
    return shown + (f" +{len(regions) - 1}" if len(regions) > 1 else "")


def real_company(name: str) -> bool:
    words = re.findall(r"[a-z]+", (name or "").lower())
    return bool(words) and not set(words) <= _NOT_A_NAME


def baseline_day(
    listings: list[dict],
    *,
    first_seen_since: str = FIRST_SEEN_SINCE,
) -> str | None:
    return first_seen_since


def canada_first_scan(
    x: dict,
    *,
    canada_since: str = CANADA_SINCE,
) -> bool:
    regions = [g for g in x.get("regions") or [] if isinstance(g, dict)]
    return (
        bool(regions)
        and all(g.get("kind") == "canada" for g in regions)
        and str(x.get("first_seen") or "")[:10] <= canada_since
    )


def load(
    site_dir: str,
    *,
    data_dir: str | None = None,
    ca_metros: Collection[str] = CA_METRO_PAGES,
    metro: Callable[[dict], str | None] = us_metro,
    baseline: Callable[[list[dict]], str | None] = baseline_day,
    valid_row: Callable[..., bool] = well_formed,
    valid_url: Callable[..., str | None] = safe_url,
    diagnostic: Callable[..., None] = console,
) -> dict:
    data = public_data_dir(site_dir) if data_dir is None else data_dir
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
            if not valid_row(x):
                bad += 1
                continue
            if x.get("status") != "open" or not valid_url(x.get("apply_url")):
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
        x["keys"].update(
            g["metro"] for g in regions if isinstance(g, dict) and g.get("metro") in ca_metros
        )
        # A US metro is named on the region the way the export names a Canadian one (2026-10-07), so
        # place(), places() and city_name read both alike.
        for g in regions:
            m = metro(g) if isinstance(g, dict) and g.get("kind") != "canada" else None
            if m:
                g["metro"] = m
                x["keys"].add(m)
    if bad:
        diagnostic(
            f"[seo] warning: skipped {bad} malformed listing rows (see well_formed)",
            file=sys.stderr,
            level=logging.WARNING,
        )
    listings = list(by_id.values())
    return {
        "generated_at": index.get("generated_at"),
        "listings": listings,
        "majors": majors.get("majors", []),
        "baseline": baseline(listings),
    }


def fresh(
    x: dict,
    now: datetime,
    baseline: str | None = None,
    *,
    new_days: int = NEW_DAYS,
    when: Callable[..., datetime | None] = _when,
    canada_first: Callable[[dict], bool] = canada_first_scan,
) -> bool:
    seen, posted = when(x.get("first_seen")), when(x.get("posted_at"))
    if baseline and str(x.get("first_seen") or "")[:10] <= baseline:
        return False
    today = now.astimezone(timezone.utc).date()
    if canada_first(x):
        return bool(posted and (today - posted.date()).days < new_days)
    return bool(
        seen
        and (today - seen.date()).days < new_days
        and (posted is None or (today - posted.date()).days < 2 * new_days)
    )


def near_home_first(
    items: list[dict],
    *,
    home_states: set[str] = HOME_STATES,
    sort_newest: Callable[[list[dict]], list[dict]] = newest_first,
) -> list[dict]:
    ordered = sort_newest(items)
    return [x for x in ordered if x["keys"] & home_states] + [
        x for x in ordered if not x["keys"] & home_states
    ]


def shown(
    items: list[dict],
    state: str | None = None,
    *,
    per_page: int = PER_PAGE,
    sort_home: Callable[[list[dict]], list[dict]] = near_home_first,
    sort_newest: Callable[[list[dict]], list[dict]] = newest_first,
) -> list[dict]:
    return (sort_newest(items) if state else sort_home(items))[:per_page]


def employer_key(
    name: str,
    *,
    aliases: Mapping[str, str] = EMPLOYER_ALIASES,
    suffix: re.Pattern[str] = _SUFFIX,
) -> str:
    k = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9& ]+", " ", name.lower())).strip()
    k = re.sub(r"^the ", "", k)
    while suffix.search(k):
        k = suffix.sub("", k).strip()
    return aliases.get(k, k) or name.lower()


def dedupe_roles(
    items: list[dict],
    *,
    sort_newest: Callable[[list[dict]], list[dict]] = newest_first,
    location: Callable[..., str] = place,
) -> list[dict]:
    seen, out = set(), []
    for x in sort_newest(items):
        key = (re.sub(r"\W+", " ", (x.get("title") or "").lower()).strip(), location(x))
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out


def unique_roles(
    items: list[dict],
    *,
    key_for: Callable[[str], str] = employer_key,
    dedupe: Callable[[list[dict]], list[dict]] = dedupe_roles,
) -> list[dict]:
    by_employer: dict[str, list[dict]] = {}
    for x in items:
        by_employer.setdefault(key_for(x.get("company_name") or ""), []).append(x)
    return [x for group in by_employer.values() for x in dedupe(group)]


def new_roles(
    d: dict,
    now: datetime,
    *,
    is_fresh: Callable[..., bool] = fresh,
    unique: Callable[[list[dict]], list[dict]] = unique_roles,
) -> list[dict]:
    return unique([x for x in d["listings"] if is_fresh(x, now, d["baseline"])])


def real_salary(
    x: dict,
    *,
    invalid_pay: Callable[..., bool] = placeholder_pay,
) -> str | None:
    s = x.get("salary")
    return str(s) if s and not invalid_pay(s) else None


def is_paid(
    x: dict,
    *,
    invalid_pay: Callable[..., bool] = placeholder_pay,
) -> bool:
    # A placeholder salary is not pay. export_static used to turn one into insights.pay "paid" as
    # well, and an export made before that fix still carries it, so a placeholder settles it.
    if x.get("salary") and invalid_pay(x["salary"]):
        return False
    return bool(x.get("salary")) or ((x.get("insights") or {}).get("pay") == "paid")


def pay_text(
    x: dict,
    *,
    salary: Callable[[dict], str | None] = real_salary,
    paid: Callable[[dict], bool] = is_paid,
) -> str:
    return salary(x) or ("Paid" if paid(x) else "")


STUDENT_STAGES = {"internship", "co_op", "research", "fellowship"}
