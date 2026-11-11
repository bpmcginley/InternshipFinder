"""Selected pay and coverage facts shared by site and growth output."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable, Collection, Mapping

from .source import real_salary
from .text import join_words, pct, plural


_HOURLY = re.compile(r"\b(hour|hr|hourly)\b", re.I)


_NOT_HOURLY = re.compile(r"\b(year|yr|annual|annually|month|week|stipend|salary)\b", re.I)


_THOUSANDS = re.compile(r"\d\s*k\b", re.I)


_CUT_OFF = re.compile(r"\d,\s*$")


_POINT_THOUSANDS = re.compile(r"\d\.\d{3}\b")


_AMOUNT = re.compile(r"\d[\d,]*(?:\.\d+)?")


def top(counts: Counter, n: int | None = None) -> list:
    """Counter.most_common, but ties broken by the key itself. most_common breaks them by insertion
    order, and counting over a set inserts in hash order, which Python changes on every run: one
    employer page said "mostly in nonprofit, marketing and communications" on one build and
    "... communications and marketing" on the next."""
    return [k for k, _ in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]]


def coverage_line(f: dict) -> str:
    """ "14,366 open internships, co-ops and research roles from 1,702 employers in 65 fields" """
    return (
        f"{plural(f['open'], 'open internship, co-op and research role', 'open internships, co-ops and research roles')}"
        f" from {plural(f['employers'], 'employer')} in {plural(len(f['fields']), 'field')}"
    )


def boards_line(f: dict) -> str:
    """Where the listings come from, counted: "86% of open roles come straight from employers' own
    applicant tracking systems (Workday, Greenhouse, Oracle, iCIMS, Ashby and Lever are the largest)"."""
    if not f["from_boards"]:
        return "every open role links to the posting on the employer's own site"
    return (
        f"{pct(f['from_boards'], f['open'])} of open roles come straight from employers' own applicant "
        f"tracking systems ({join_words(top(f['boards'], 6))} are the largest)"
    )


def word_list(words: list[str]) -> str:
    """join_words with a comma before the last "and", for names that hold an "and" themselves:
    "finance, data science and analytics, and operations"."""
    return join_words(words) if len(words) < 3 else ", ".join(words[:-1]) + ", and " + words[-1]


def canada_only(x: dict) -> bool:
    """A role whose every location is in Canada, so its pay is most likely in Canadian dollars."""
    regions = [g for g in x.get("regions") or [] if isinstance(g, dict)]
    return bool(regions) and all(g.get("kind") == "canada" for g in regions)


def hourly_rate(
    x: dict, *, salary: Callable[[dict], str | None] = real_salary
) -> tuple[float, float] | None:
    """One posting's listed hourly rate as (low, high), or None when it gives no clear one. A bare
    amount counts as hourly only under $200 (student pay quoted without a unit is an hourly rate); a
    yearly salary, monthly or weekly pay or a stipend is left out rather than turned into a made-up
    hourly figure, and so is pay text that only looks hourly (_THOUSANDS, _CUT_OFF, _POINT_THOUSANDS)."""
    s = salary(x)
    if not s or any(r.search(s) for r in (_NOT_HOURLY, _THOUSANDS, _CUT_OFF, _POINT_THOUSANDS)):
        return None
    # was: if not s or _NOT_HOURLY.search(s): continue   (inside hourly_range's loop)
    nums = [float(a.replace(",", "")) for a in _AMOUNT.findall(s)]
    nums = (
        [v for v in nums if 7 <= v < 200]
        if (_HOURLY.search(s) or all(v < 200 for v in nums))
        else []
    )
    return (min(nums), max(nums)) if nums else None


def hourly_range(
    items: list[dict], *, rate: Callable[[dict], tuple[float, float] | None] = hourly_rate
) -> tuple[float, float, int] | None:
    """Lowest and highest hourly rate the postings list, and how many list one (see hourly_rate)."""
    rates = [r for r in (rate(x) for x in items) if r]
    # was: the parsing now in hourly_rate, inline in a loop here.
    return (min(lo for lo, _ in rates), max(hi for _, hi in rates), len(rates)) if rates else None


def site_facts(
    listings: list[dict],
    *,
    skip_fields: set[str],
    ats_names: Mapping[str, str],
    places: Collection[str],
    provinces: Collection[str],
    employer_key: Callable[[str], str],
    hourly_rate: Callable[[dict], tuple[float, float] | None],
    is_paid: Callable[[dict], bool],
) -> dict:
    """What the whole export says about InternScout's coverage: the numbers /about/, /compare/ and
    llms.txt state, so they all agree with each other and with the listing pages."""
    fields = Counter(t for x in listings for t in set(x.get("field_tags") or []) - skip_fields)
    boards = Counter(ats_names[x["ats"]] for x in listings if x.get("ats") in ats_names)
    keys = {k for x in listings for k in x["keys"]}
    canada = sum(
        1
        for x in listings
        if any(isinstance(g, dict) and g.get("kind") == "canada" for g in x.get("regions") or [])
    )
    return {
        "open": len(listings),
        "employers": len(
            {employer_key(x["company_name"]) for x in listings if x.get("company_name")}
        ),
        "fields": fields,
        "boards": boards,
        "from_boards": sum(boards.values()),
        "canada": canada,
        # The 50 states only: DC and Puerto Rico are counted on their own pages, not here.
        "states": sorted(
            k for k in keys if k in places and k not in provinces and k not in ("DC", "PR")
        ),
        "provinces": sorted(k for k in keys if k in provinces),
        "paid": sum(1 for x in listings if is_paid(x)),
        "hourly": sum(1 for x in listings if hourly_rate(x)),
    }
