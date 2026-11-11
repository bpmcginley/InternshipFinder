"""Select the published Numbers page counts, links and optional pay figures."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from datetime import datetime

Count = tuple[str, int]
Link = tuple[str | None, str, int]


@dataclass(frozen=True)
class UsdPay:
    rate_count: int
    median: float
    highest: float
    canada: int


@dataclass(frozen=True)
class Page:
    open_roles: int
    employers: int
    field_count: int
    us_state_count: int
    province_count: int
    canada: int
    new: int
    paid: int
    hourly: int
    from_boards: int
    coverage: str
    kind_links: list[tuple[str, int, str]]
    pay: UsdPay | None
    board_leader: Count | None
    board_followers: list[Count] | None
    fields: list[Link]
    states: list[Link]
    state_total: int
    provinces: list[Link]
    remote: int
    limit: int
    now: datetime
    updated: str


def select_page(
    f: dict,
    listings: list[dict],
    fields: dict,
    states: dict,
    rep: dict | None,
    new: int,
    kind_made: list,
    now: datetime,
    updated: str,
    *,
    coverage: str,
    limit: int,
    places: Collection[str],
    canadian_provinces: Collection[str],
    place_names: Mapping[str, str],
    field_title: Callable[[str], str],
    field_slug: Callable[[str], str],
    state_slug: Callable[[str], str],
) -> Page:
    kinds = {kind["slug"]: (path, len(items)) for path, kind, items in kind_made}
    kind_links = [
        (*kinds[slug], label)
        for slug, label in (("co-op", "co-ops"), ("research", "research positions"))
        if slug in kinds
    ]
    pay = UsdPay(len(rep["roles"]), rep["median"], rep["top"][0][2], rep["canada"]) if rep else None

    # Each ranked list breaks count ties by the existing key.
    boards = sorted(f["boards"].items(), key=lambda item: (-item[1], item[0]))
    top_fields = sorted(f["fields"].items(), key=lambda item: (-item[1], item[0]))[:limit]
    by_state = Counter(
        key
        for listing in listings
        for key in listing["keys"]
        if key in places and key not in canadian_provinces and key not in ("DC", "PR")
    )
    top_states = sorted(by_state.items(), key=lambda item: (-item[1], item[0]))[:limit]
    by_province = Counter(
        key for listing in listings for key in listing["keys"] if key in canadian_provinces
    )
    provinces = sorted(by_province.items(), key=lambda item: (-item[1], item[0]))[:3]

    return Page(
        open_roles=f["open"],
        employers=f["employers"],
        field_count=len(f["fields"]),
        us_state_count=len(f["states"]),
        province_count=len(f["provinces"]),
        canada=f["canada"],
        new=new,
        paid=f["paid"],
        hourly=f["hourly"],
        from_boards=f["from_boards"],
        coverage=coverage,
        kind_links=kind_links,
        pay=pay,
        board_leader=boards[0] if boards else None,
        board_followers=boards[1:limit] if len(boards) > 1 else None,
        fields=[
            (f"/internships/{field_slug(tag)}/" if tag in fields else None, field_title(tag), count)
            for tag, count in top_fields
        ],
        states=[
            (f"/internships/{state_slug(key)}/" if key in states else None, place_names[key], count)
            for key, count in top_states
        ],
        state_total=len(by_state),
        provinces=[
            (f"/internships/{state_slug(key)}/" if key in states else None, place_names[key], count)
            for key, count in provinces
        ],
        remote=sum(1 for listing in listings if "remote" in listing["keys"]),
        limit=limit,
        now=now,
        updated=updated,
    )
