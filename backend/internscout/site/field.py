"""Selected listing cohorts and related links for fields, places, combinations and majors."""

from __future__ import annotations

from collections import Counter
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime



Count = tuple[str, int]
Link = tuple[str, str, int]
Questions = list[tuple[str, str]]


@dataclass(frozen=True)
class Context:
    root: tuple[str, str]
    now: datetime
    updated: str


@dataclass(frozen=True)
class Field:
    context: Context
    tag: str
    path: str
    items: list[dict]
    states: list[Count]
    cities: list[Count]
    employers: list[Link]
    more_employers: tuple[int, int] | None
    fits: list[str] | None
    signup_count: int | None
    co_ops: bool
    faq: Questions


@dataclass(frozen=True)
class Place:
    context: Context
    key: str
    path: str
    items: list[dict]
    fields: list[Count]
    cities: list[Count]
    parent_state: str | None
    co_ops: bool
    canadian: bool
    faq: Questions
    thin: bool


@dataclass(frozen=True)
class Combo:
    context: Context
    tag: str
    key: str
    path: str
    items: list[dict]
    states: list[Count]
    cities: list[Count]
    co_ops: bool
    faq: Questions
    thin: bool


@dataclass(frozen=True)
class Major:
    context: Context
    name: str
    tags: list[str]
    path: str
    items: list[dict]
    fields: list[Count]
    fits: list[str]


def counts_by_place(
    combos: Mapping[tuple[str, str], list[dict]], tag: str, exclude: str | None = None
) -> list[Count]:
    return sorted(
        (
            (place, len(rows))
            for (field, place), rows in combos.items()
            if field == tag and place != exclude
        ),
        key=lambda entry: (-entry[1], entry[0]),
    )


def counts_by_field(combos: Mapping[tuple[str, str], list[dict]], key: str) -> list[Count]:
    return sorted(
        ((field, len(rows)) for (field, place), rows in combos.items() if place == key),
        key=lambda entry: (-entry[1], entry[0]),
    )


def city_counts(
    states: Mapping[str, list[dict]],
    key: str,
    metros: Collection[str],
    parent: Mapping[str, str],
) -> list[Count]:
    return sorted(
        (
            (metro, len(states[metro]))
            for metro in metros
            if metro in states and parent[metro] == key
        ),
        key=lambda entry: (-entry[1], entry[0]),
    )


def other_states(others: list[Count], metros: Collection[str], parent: str | None) -> list[Count]:
    return [entry for entry in others if entry[0] == parent] + [
        entry for entry in others if entry[0] not in metros and entry[0] != parent
    ]


def hiring_links(
    items: list[dict], employers: Mapping[str, str], page_names: Mapping[str, str], limit: int
) -> tuple[list[Link], int]:
    hiring = Counter(
        employers[row["company_name"]] for row in items if row.get("company_name") in employers
    )
    links = [
        (path, page_names[path], count)
        for path, count in sorted(hiring.items(), key=lambda entry: (-entry[1], entry[0]))[:limit]
    ]
    return links, len(hiring)


def has_co_ops(items: list[dict]) -> bool:
    return any("co_op" in (row.get("stage") or []) for row in items)
