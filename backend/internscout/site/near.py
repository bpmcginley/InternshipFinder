"""Select the data used by near landing pages and their hub."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime

from .. import near_metros

from html import escape as esc

from .layout import link_list
from .text import join_words, lower_name, plural

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


def render_near_body(
    model: NearBody,
    *,
    autoapply_card: Callable[..., str],
    chart_figure: Callable[..., str],
    counted: Callable[..., str],
    dash_link: Callable[..., str],
    listing_rows: Callable[..., str],
    near_how: Callable[..., str],
    summary: Callable[..., str],
    per_page: int,
    place_names: Mapping[str, str],
) -> str:
    label, lname = near_metros.metro_label(model.metro), lower_name(model.field["name"])
    key = (
        "near:" + model.metro["cbsa"]
    )  # no region is filed under this, so place() leads with regions[0]
    items = model.items
    dash = dash_link(model.dashboard_tags, ",".join(model.states))
    out = []
    if items:
        lead = summary(items, f"in {lname}", f" near {label}", tail="")
        if len(model.towns) > 1:
            lead += " " + esc(f"By town: {counted(model.towns, 3)}.")
        out.append(f"<p class=\"lede\">{lead}</p>")
    else:
        out.append(
            f"<p class=\"lede\">{esc(f'InternScout has no open {lname} roles with a location near {label} right now.')} "
            "Listings are collected from public job boards several times a day, so this page changes as "
            "employers post.</p>"
        )
    out.append(f"<p class=\"fits\">{esc(near_how(model.metro, model.field))}</p>")
    cta = f"Search {lname} roles in {join_words([place_names[k] for k in model.states])} on the dashboard"
    out.append(f"<a class=\"cta\" href=\"{dash}\">{esc(cta)}</a>")
    if items:
        out.append(autoapply_card(items, "seo-near", key))
        rows = listing_rows(items, model.now, key, model.path, "seo-near")
        out.append(f"<ul class=\"jobs\">{rows}</ul>")
        if len(items) > per_page:
            out.append(
                f"<p class=\"more\">Showing the {per_page} newest of {len(items):,}. "
                f"<a href=\"{dash}\">See every one on the dashboard</a>.</p>"
            )
        out.append(chart_figure(items, key))
    # Remote roles, apart and labelled: open to a student in this city, but not in it.
    if model.remote_count:
        words = (
            f"{plural(model.remote_count, 'remote ' + lname + ' role')} "
            f"{'is' if model.remote_count == 1 else 'are'} open to students anywhere in the US. "
            "They are not counted above."
        )
    else:
        words = f"No remote {lname} roles are open right now."
    section = (
        f"<section class=\"rel\"><h2>{esc('Remote ' + lname + ' roles')}</h2><p class=\"more\">{esc(words)}"
        + (
            f" <a href=\"{dash_link(model.dashboard_tags, 'remote')}\">See them on the dashboard</a>."
            if model.remote_count
            else ""
        )
        + "</p>"
    )
    if model.shown_remote is not None:
        rows = listing_rows(model.shown_remote, model.now, "remote", model.path, "seo-near")
        section += f"<ul class=\"jobs\">{rows}</ul>"
    out.append(section + "</section>")
    if items:
        out.append(
            "<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
            "<a href=\"feed.xml\">RSS feed</a></p>"
        )
    return "".join(out)


def render_near_page(
    model: NearPage,
    *,
    near_description: Callable[..., str],
    near_title: Callable[..., str],
    near_root: str,
    render_body: Callable[[NearBody], str],
) -> dict:
    body = model.body
    f, m = body.field, body.metro
    path, items = body.path, model.items
    related = "".join(link_list(label, links) for label, links in model.related)
    return {
        "path": path,
        "title": near_title(f, m, items),
        "desc": near_description(f, m, items, body.remote_count, model.updated),
        "h1": f"{f['name']} internships near {model.label}",
        "crumbs": [
            ("/internships/", "Internships"),
            (near_root, "Near 50 US cities"),
            (path, f"{f['name']} near {m['city']}"),
        ],
        "body": render_body(body) + related + render_footer(near_root),
        "items": items or None,
        "state": "near:" + m["cbsa"],
        "thin": not model.indexed,
        "kind": "near",
    }


def render_footer(near_root: str) -> str:
    return f"<p class=\"more\"><a href=\"{near_root}\">Every field near all 50 cities</a></p>"


def render_near_hub(groups: list[LinkGroup]) -> tuple[list[str], str, str]:
    sections = [link_list(title, links) for title, links in groups]
    body = (
        "<p class=\"lede\">Internships in ten of the largest college degree fields, near each of the 50 largest "
        "US metro areas. The fields are the ten largest by bachelor's degrees awarded in 2021-22 (NCES Digest "
        "2023, Table 322.10). The metro areas are the 50 largest by population (Census estimates for July 2025). "
        "Each number is how many open roles have a location in that metro area now. A role in two cities "
        "counts in both. Remote roles are listed apart on each page.</p>" + "".join(sections)
    )
    title = ["Internships by Field Near 50 US Cities", "Internships Near 50 US Cities"]
    desc = (
        "Internships in the ten largest college degree fields near the 50 largest US metro areas, counted by "
        "city and field from open listings. Remote roles listed apart. Free, no sign-up."
    )
    return title, desc, body
