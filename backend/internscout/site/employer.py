"""Select the related listing data for employer pages."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace
from datetime import datetime
from collections.abc import Mapping
import re


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
class CompanyFollow:
    key: str
    label: str
    identities: tuple[tuple[str, str, str], ...]


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
    follow_company: CompanyFollow | None = None


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


def _follow_text(value, limit):
    return (
        type(value) is str
        and bool(value)
        and value == value.strip()
        and not re.search(r"[\x00-\x1f\x7f\ud800-\udfff]", value)
        and len(value.encode("utf-8")) <= limit
    )


def _follow_identities(model):
    if not model.items or not _follow_text(model.name, 200):
        raise ValueError("Invalid employer Follow selection")
    rows = []
    for row in model.items:
        if (
            type(row) is not dict
            or row.get("status") != "open"
            or type(row.get("id")) is not str
            or not re.fullmatch(r"[a-f0-9]{16}", row["id"])
            or not _follow_text(row.get("company_name"), 200)
            or not _follow_text(row.get("follow_company_key"), 200)
        ):
            raise ValueError("Invalid employer Follow selection")
        rows.append((row["id"], row["company_name"], row["follow_company_key"]))
    if len({row[0] for row in rows}) != len(rows):
        raise ValueError("Invalid employer Follow selection")
    return tuple(rows)


def with_company_follow(
    model: Page, *, aliases: Mapping[str, str], companies: frozenset[str]
) -> Page:
    """Trusted caller supplies current catalog sets from the SAME original export as #570 rows.

    No catalog acquisition, normalization, fallback, publication or release policy is inferred.
    """
    identities = _follow_identities(model)
    names = {model.name, *model.spellings, *(row[1] for row in identities)}
    key = identities[0][2]
    if (
        not isinstance(aliases, Mapping)
        or type(companies) is not frozenset
        or key not in companies
        or any(not _follow_text(name, 200) or aliases.get(name) != key for name in names)
        or any(row[2] != key for row in identities)
    ):
        raise ValueError("Invalid employer Follow selection")
    return replace(model, follow_company=CompanyFollow(key, model.name, identities))


def validated_company_follow(model: Page) -> CompanyFollow | None:
    selected = model.follow_company
    if selected is not None and (
        type(selected) is not CompanyFollow
        or selected.label != model.name
        or not _follow_text(selected.key, 200)
        or selected.identities != _follow_identities(model)
        or any(row[2] != selected.key for row in selected.identities)
    ):
        raise ValueError("Stale employer Follow selection")
    return selected
