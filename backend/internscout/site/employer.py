"""Select the related listing data for employer pages."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime




@dataclass(frozen=True)
class Directory:
    companies: dict[str, list[dict]]
    company_fields: dict[str, list[str]]
    paths: dict[str, str]
    fields: dict[str, list[dict]]
    combos: dict[tuple[str, str], list[dict]]


@dataclass(frozen=True)
class Related:
    similar: list[tuple[str, str, int]]
    fields: list[tuple[str, int]]
    places: list[tuple[str, str, int]]


@dataclass(frozen=True)
class Page:
    name: str
    path: str
    items: list[dict]
    main: list[str]
    links: Related
    where: str
    spellings: list[str]
    root: tuple[str, str]
    now: datetime
    term: str | None
    named: list[str]
    pay: tuple[float, float, int] | None
    newest: datetime | None
    co_ops: int
    own_links: bool
    thin: bool
    details: dict[str, tuple[tuple[str, str], ...]] | None
    export_stamp: datetime | None = None


def select_links(
    directory: Directory,
    name: str,
    items: list[dict],
    main: list[str],
    *,
    related_limit: int,
    place_limit: int,
) -> Related:
    # Rank by fields shared, then size, then name.
    similar = sorted(
        (
            (len(set(main) & set(fields)), len(directory.companies[other]), other)
            for other, fields in directory.company_fields.items()
            if other != name and set(main) & set(fields)
        ),
        key=lambda entry: (-entry[0], -entry[1], entry[2]),
    )[:related_limit]
    # Rank by how many of this employer's own roles are on a field-in-a-place page.
    place_counts = Counter(
        (tag, place)
        for item in items
        for tag in main
        for place in item["keys"]
        if (tag, place) in directory.combos and tag in (item.get("field_tags") or [])
    )
    ranked_places = sorted(place_counts.items(), key=lambda entry: (-entry[1], entry[0]))
    return Related(
        similar=[(directory.paths[other], other, count) for _, count, other in similar],
        fields=[(tag, len(directory.fields[tag])) for tag in main if tag in directory.fields],
        places=[
            (tag, place, len(directory.combos[(tag, place)]))
            for (tag, place), _ in ranked_places[:place_limit]
        ],
    )
