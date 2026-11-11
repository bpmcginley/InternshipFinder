"""Select the hourly pay cohorts and keep the values rendered on the pay page."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from statistics import median


@dataclass(frozen=True)
class Limits:
    per_employer: int
    top: int
    field: int
    employer: int
    employer_rows: int


@dataclass(frozen=True)
class Page:
    report: dict
    open_roles: int
    hourly: int
    paid: int
    now: datetime
    field_totals: dict[str, int]
    graduate: int
    paid_page: bool
    per_employer: int
    min_field: int
    min_employer: int


def select_report(
    listings: list[dict],
    fields: dict[str, list],
    *,
    limits: Limits,
    newest_first: Callable[[list[dict]], list[dict]],
    hourly_rate: Callable[[dict], tuple[float, float] | None],
    canada_only: Callable[[dict], bool],
    place: Callable[[dict], str],
    employer_key: Callable[[str], str],
    field_title: Callable[[str], str],
    real_salary: Callable[[dict], str | None],
) -> dict:
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
    mid = lambda lo, hi: (lo + hi) / 2  # noqa: E731  a range counts as its midpoint in a median
    # Ranked by the top of the range, then its bottom; ties go to the name, title and id, so every
    # build of the same data lists them in the same order.
    ranked = sorted(
        roles,
        key=lambda r: (
            -r[2],
            -r[1],
            str(r[0].get("company_name") or ""),
            str(r[0].get("title") or ""),
            r[0]["id"],
        ),
    )
    per: Counter = Counter()
    top_roles = []
    for r in ranked:
        k = employer_key(r[0].get("company_name") or "")
        if per[k] < limits.per_employer and len(top_roles) < limits.top:
            per[k] += 1
            top_roles.append(r)
    by_field = []
    for t in sorted(fields):
        rates = [(lo, hi) for x, lo, hi in roles if t in (x.get("field_tags") or [])]
        if len(rates) >= limits.field:
            by_field.append(
                (t, len(rates), median(mid(lo, hi) for lo, hi in rates), max(hi for _, hi in rates))
            )
    by_field.sort(key=lambda r: (-r[2], -r[3], field_title(r[0])))
    groups: dict[str, list] = {}
    for x, lo, hi in roles:
        if x.get("company_name"):
            groups.setdefault(employer_key(x["company_name"]), []).append((x, lo, hi))
    by_employer = []
    for _, rs in sorted(groups.items()):
        if len(rs) < limits.employer:
            continue
        names = Counter(x["company_name"] for x, _, _ in rs)
        name = min(names, key=lambda n: (-names[n], len(n), n))  # the spelling build() picks
        by_employer.append(
            (
                name,
                len(rs),
                median(mid(lo, hi) for _, lo, hi in rs),
                min(lo for _, lo, _ in rs),
                max(hi for _, _, hi in rs),
            )
        )
    by_employer.sort(key=lambda r: (-r[2], -r[4], r[0]))
    return {
        "roles": roles,
        "top": top_roles,
        "by_field": by_field,
        "by_employer": by_employer[: limits.employer_rows],
        "employers_listing": sum(1 for rs in groups.values() if len(rs) >= limits.employer),
        "median": median(mid(lo, hi) for _, lo, hi in roles) if roles else None,
        # Roles whose pay is given some other way: a yearly salary, monthly pay, a stipend.
        "other_pay": sum(1 for x in listings if real_salary(x) and not hourly_rate(x)),
        "canada": sum(1 for x in listings if hourly_rate(x) and canada_only(x)),
    }
