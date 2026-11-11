"""Select the related listing data for employer pages."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from html import escape as esc

from .layout import link_list


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


def render_employer_page(
    model: Page,
    *,
    combo_label: Callable[..., str],
    dash_link: Callable[..., str],
    employer_breakdown: Callable[..., str],
    employer_description: Callable[..., str],
    employer_offer: Callable[..., str],
    employer_title: Callable[..., str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    listing_body: Callable[..., str],
    state_slug: Callable[..., str],
    employer_facts: Callable[..., tuple[str, str]],
) -> dict:
    name, items, path, main = model.name, model.items, model.path, model.main
    note = (
        f"<p class=\"more\">InternScout is not affiliated with {esc(name)}. These are roles InternScout "
        f"found on {esc(name)}'s public job boards; always apply on the employer's own site.</p>"
    )
    facts, questions = employer_facts(name, items, main)
    related = (
        employer_breakdown(name, items, main)
        + questions
        + note
        + employer_offer(name)
        + link_list("Similar employers", model.links.similar)
        + link_list(
            "Related fields",
            [
                (f"/internships/{field_slug(t)}/", field_title(t), count)
                for t, count in model.links.fields
            ],
        )
        # The field-in-a-place pages this employer's own roles are on, most of its roles first.
        + link_list(
            "Related internships by place",
            [
                (f"/internships/{field_slug(t)}/{state_slug(k)}/", combo_label(t, k), count)
                for t, k, count in model.links.places
            ],
        )
    )
    desc = employer_description(
        name,
        len(items),
        model.term,
        model.named,
        model.pay,
        model.newest,
        model.co_ops,
        own_links=model.own_links,
    )
    return {
        "path": path,
        "title": employer_title(name, len(items), model.term),
        "desc": desc,
        "h1": f"Internships at {name}",
        "crumbs": [model.root, ("/internships/at/", "By employer"), (path, name)],
        "body": listing_body(
            items,
            f"at {name}",
            "",
            model.now,
            related,
            dash=dash_link(state=model.where, companies=model.spellings),
            here=path,
            extra=facts,
            src="seo-employer",
            details=model.details,
        ),
        "items": items,
        "kind": "employer",
        "thin": model.thin,
    }
