"""Render the employer page models."""

from __future__ import annotations

from collections.abc import Callable
from html import escape as esc

from ..employer import Page
from .layout import link_list


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
            export_stamp=model.export_stamp,
        ),
        "items": items,
        "kind": "employer",
        "thin": model.thin,
    }
