"""Select kind-page cohorts, related links and employer opening rows."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone

Link = tuple[str, str, int]
KindSelection = tuple[str, dict, list[dict]]


@dataclass(frozen=True)
class KindPage:
    path: str
    kind: dict
    items: list[dict]
    root: tuple[str, str]
    now: datetime
    updated: str
    related_fields: list[Link]
    related_kinds: list[Link]
    tracker: tuple[str, str] | None


@dataclass(frozen=True)
class TrackerPage:
    term: str
    rows: list[tuple]
    roles: int
    updated: str
    term_path: str
    opened_this_week: int
    has_floor: bool


def select_kinds(
    kinds: list[dict],
    listings: list[dict],
    taken: set[str],
    enough: Callable[[int, str, int], bool],
    minimum: int,
) -> list[KindSelection]:
    made = []
    for kind in kinds:
        path = f"/internships/{kind['slug']}/"
        items = [row for row in listings if kind["pick"](row)]
        if path not in taken and enough(len(items), path, minimum):
            made.append((path, kind, items))
    return made


def related_fields(
    items: list[dict],
    fields: dict[str, list],
    skip_fields: set[str] | frozenset[str],
    top: Callable[[Counter, int], list],
    field_slug: Callable[[str], str],
    field_title: Callable[[str], str],
    limit: int,
) -> list[Link]:
    by_tag = Counter(
        tag
        for row in items
        for tag in set(row.get("field_tags") or []) - skip_fields
        if tag in fields
    )
    return [
        (f"/internships/{field_slug(tag)}/", field_title(tag), len(fields[tag]))
        for tag in top(by_tag, limit)
    ]


def related_kinds(made: list[KindSelection], path: str) -> list[Link]:
    return [
        (other, kind["h1"][0].upper() + kind["h1"][1:], len(items))
        for other, kind, items in made
        if other != path
    ]


def opened_rows(
    items: list[dict],
    year: int,
    baseline: str | None,
    *,
    employers: Mapping[str, str],
    real_company: Callable[[str], bool],
    employer_key: Callable[[str], str],
    opened_on: Callable[[dict, int, str | None], tuple | None],
    dedupe_roles: Callable[[list[dict]], list[dict]],
) -> list[tuple]:
    groups: dict[str, list] = {}
    for x in items:
        if x.get("company_name") and real_company(
            x["company_name"]
        ):  # not "APPLY NOW" (real_company)
            groups.setdefault(employer_key(x["company_name"]), []).append(x)
    rows = []
    for _, its in sorted(groups.items()):
        names = Counter(x["company_name"] for x in its)
        path = next((employers[n] for n in sorted(names) if n in employers), None)
        name = min(names, key=lambda n: (-names[n], len(n), n))
        days = [d for d in (opened_on(x, year, baseline) for x in its) if d]
        if not days:
            continue
        day, exact = min(days, key=lambda d: (d[0], not d[1]))
        rows.append((day, exact, name, path, len(dedupe_roles(its))))
    return sorted(rows, key=lambda r: (-r[0].toordinal(), not r[1], r[2].lower(), r[2]))


def select_tracker(
    term: str,
    rows: list[tuple],
    roles: int,
    now: datetime,
    updated: str,
    term_path: str,
    new_days: int,
) -> TrackerPage:
    today = now.astimezone(timezone.utc).date()
    return TrackerPage(
        term=term,
        rows=rows,
        roles=roles,
        updated=updated,
        term_path=term_path,
        opened_this_week=sum(1 for row in rows if row[1] and (today - row[0]).days < new_days),
        has_floor=any(not row[1] for row in rows),
    )
