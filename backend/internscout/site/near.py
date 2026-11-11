"""Select the data used by near landing pages and their hub."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime

from .. import near_metros

LocalRow = tuple[dict, list[dict]]
Link = tuple[str, str, int]
LinkGroup = tuple[str, list[Link]]
Hub = dict[tuple[str, str], Link]


@dataclass(frozen=True)
class NearPage:
    body: NearBody
    label: str
    items: list[dict]
    updated: str
    indexed: bool
    related: tuple[LinkGroup, LinkGroup]


@dataclass(frozen=True)
class NearBody:
    field: dict
    metro: dict
    path: str
    items: list[dict]
    now: datetime
    dashboard_tags: list[str]
    states: list[str]
    towns: list[tuple[str, int]]
    remote_count: int
    shown_remote: list[dict] | None


def select_body(
    field: dict,
    metro: dict,
    local: list[LocalRow],
    remote: list[dict],
    now: datetime,
    path: str,
    indexed: bool,
    *,
    view: Callable[[dict, list[dict]], dict],
    town: Callable[[dict, str], str],
    remote_limit: int,
) -> NearBody:
    items = [view(x, regs) for x, regs in local]
    tags = list(near_metros.FIELD_TAGS[field["slug"]])
    # The dashboard reads at most six fields (docs/js/core.js filtersFromUrl).
    by_tag = Counter(t for x, _ in local for t in x.get("field_tags") or [] if t in tags)
    dash_tags = sorted(tags, key=lambda t: (-by_tag[t], tags.index(t)))[:6]
    # The dashboard filters by state, not by town.
    states = near_metros.metro_states(metro["cbsa"])
    towns = Counter(n for _, regs in local for n in {town(g, metro["cbsa"]) for g in regs} if n)
    return NearBody(
        field=field,
        metro=metro,
        path=path,
        items=items,
        now=now,
        dashboard_tags=dash_tags,
        states=states,
        towns=sorted(towns.items(), key=lambda kv: (-kv[1], kv[0])),
        remote_count=len(remote),
        shown_remote=remote[:remote_limit] if remote and not indexed else None,
    )


def select_pages(
    listings: list[dict],
    now: datetime,
    updated: str,
    live,
    earning: frozenset,
    rivals: list[frozenset],
    *,
    group_local: Callable[[list[dict]], dict[str, list[LocalRow]]],
    sort_newest: Callable[[list[dict]], list[dict]],
    path_for: Callable[[dict, str], str],
    view: Callable[[dict, list[dict]], dict],
    should_index: Callable[[list[dict], str, object, frozenset, list[frozenset]], bool],
    body_for: Callable[[dict, dict, list[LocalRow], list[dict], datetime, str, bool], NearBody],
) -> tuple[Iterator[NearPage], Hub]:
    local_by_metro = group_local(listings)
    remote_all = sort_newest([x for x in listings if near_metros.us_remote(x)])

    def tagged(slug: str, x: dict) -> bool:
        return bool(set(near_metros.FIELD_TAGS[slug]) & set(x.get("field_tags") or []))

    grid = {
        (m["cbsa"], f["slug"]): [
            (x, regs) for x, regs in local_by_metro.get(m["cbsa"], []) if tagged(f["slug"], x)
        ]
        for m in near_metros.METROS
        for f in near_metros.FIELDS
    }
    remote_by_field = {
        f["slug"]: [x for x in remote_all if tagged(f["slug"], x)] for f in near_metros.FIELDS
    }
    hub = {
        (m["cbsa"], f["slug"]): (
            path_for(m, f["slug"]),
            f["name"],
            len(grid[(m["cbsa"], f["slug"])]),
        )
        for m in near_metros.METROS
        for f in near_metros.FIELDS
    }

    def pages() -> Iterator[NearPage]:
        for m in near_metros.METROS:
            label = near_metros.metro_label(m)
            for f in near_metros.FIELDS:
                local = grid[(m["cbsa"], f["slug"])]
                path = path_for(m, f["slug"])
                ids = {x["id"] for x, _ in local}
                remote = [x for x in remote_by_field[f["slug"]] if x["id"] not in ids]
                items = [view(x, regs) for x, regs in local]
                indexed = should_index(items, path, live, earning, rivals)
                # The city's other fields and the field's other cities, most roles first (then by name).
                fields_here = sorted(
                    (
                        hub[(m["cbsa"], ff["slug"])]
                        for ff in near_metros.FIELDS
                        if ff["slug"] != f["slug"]
                    ),
                    key=lambda e: (-e[2], e[1]),
                )
                cities = sorted(
                    (
                        (
                            hub[(mm["cbsa"], f["slug"])][0],
                            near_metros.metro_label(mm),
                            hub[(mm["cbsa"], f["slug"])][2],
                        )
                        for mm in near_metros.METROS
                        if mm["cbsa"] != m["cbsa"]
                    ),
                    key=lambda e: (-e[2], e[1]),
                )
                body = body_for(f, m, local, remote, now, path, indexed)
                yield NearPage(
                    body=body,
                    label=label,
                    items=items,
                    updated=updated,
                    indexed=indexed,
                    related=(
                        (f"Other fields near {m['city']}", fields_here),
                        (f"{f['name']} internships near other cities", cities),
                    ),
                )

    return pages(), hub


def select_hub(hub: Hub) -> list[LinkGroup]:
    return [
        (
            f"Near {near_metros.metro_label(m)}",
            [hub[(m["cbsa"], f["slug"])] for f in near_metros.FIELDS],
        )
        for m in near_metros.METROS
    ]
