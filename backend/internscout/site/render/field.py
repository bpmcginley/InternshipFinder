"""Render the field page models."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from html import escape as esc

from ..field import Field, Place, Combo, Major
from ..text import lower_name
from .layout import faq_ld, faq_section, link_list


def render_field(
    model: Field,
    *,
    dash_link: Callable[..., str],
    field_short: Callable[..., str],
    field_title: Callable[..., str],
    listing_body: Callable[..., str],
    listing_description: Callable[..., str],
    listing_title: Callable[..., str],
    signup_form: Callable[..., str],
    state_slug: Callable[..., str],
    widget_follow: Callable[..., str],
    place_names: Mapping[str, str],
) -> dict:
    t, path, items = model.tag, model.path, model.items
    root, now, updated = model.context.root, model.context.now, model.context.updated
    name = field_title(t)
    related = link_list(
        f"{name} internships by state",
        [(f"{path}{state_slug(k)}/", place_names[k], n) for k, n in model.states],
    )
    related += link_list(
        f"{name} internships by city",
        [(f"{path}{state_slug(k)}/", place_names[k], n) for k, n in model.cities],
    )
    related += link_list(f"Employers hiring in {lower_name(name)}", model.employers)
    # The employer list stops at RELATED; the rest are a click away.
    if model.more_employers is not None:
        total, hiring = model.more_employers
        related += (
            f"<p class=\"more\"><a href=\"/internships/at/\">All {total:,} employers hiring "
            f"now</a>, {hiring:,} of them in {esc(lower_name(name))}.</p>"
        )
    qa, co_ops = model.faq, model.co_ops
    pitch = (
        f"{model.signup_count:,} new {esc(lower_name(name))} internships in the last week."
        if model.signup_count is not None
        else ""
    )
    related += widget_follow(t)
    return {
        "path": path,
        "title": listing_title(
            [f"{name} Internships", f"{field_short(t)} Internships"], len(items)
        ),
        "desc": listing_description(
            len(items),
            f"{lower_name(name)} internships{' and co-ops' if co_ops else ''}",
            "",
            items,
            updated,
        ),
        "h1": f"{name} internships",
        "crumbs": [root, (path, name)],
        "body": listing_body(
            items,
            f"in {lower_name(name)}",
            "",
            now,
            related,
            dash=dash_link([t]),
            fits=model.fits,
            src="seo-field",
            faq=faq_section(qa),
            signup=signup_form(pitch, t),
            export_stamp=model.context.export_stamp,
        ),
        "items": items,
        "ld": [faq_ld(qa)],
        "kind": "field",
        "share_view": (t, "all"),
        "share_card": (f"{name} internships", None),
    }


def render_place(
    model: Place,
    *,
    dash_link: Callable[..., str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    in_place: Callable[..., str],
    listing_body: Callable[..., str],
    listing_description: Callable[..., str],
    listing_title: Callable[..., str],
    state_slug: Callable[..., str],
    place_names: Mapping[str, str],
) -> dict:
    k, path, items = model.key, model.path, model.items
    root, now, updated = model.context.root, model.context.now, model.context.updated
    where = place_names[k]
    related = link_list(
        f"Internships {in_place(k)} by field",
        [
            (f"/internships/{field_slug(t)}/{state_slug(k)}/", field_title(t), n)
            for t, n in model.fields
        ],
    )
    related += link_list(
        f"Internships {in_place(k)} by city",
        [(f"/internships/{state_slug(m)}/", m, n) for m, n in model.cities],
    )
    crumbs = [root, (path, where)]
    if model.parent_state is not None:
        st = model.parent_state
        crumbs = [root, (f"/internships/{state_slug(st)}/", place_names[st]), (path, where)]
    loc = "remote" if k == "remote" else in_place(k)
    head = f"Internships {'(Remote)' if k == 'remote' else in_place(k)}"
    qa, co_ops = model.faq, model.co_ops
    subjects = ([f"Internships and Co-ops {in_place(k)}"] if model.canadian and co_ops else []) + [
        head
    ]
    return {
        "path": path,
        "title": listing_title(subjects, len(items)),
        "desc": listing_description(
            len(items),
            "internships and co-ops" if co_ops else "internships",
            "that are remote" if k == "remote" else loc,
            items,
            updated,
        ),
        "h1": f"Internships {'you can do remotely' if k == 'remote' else in_place(k)}",
        "crumbs": crumbs,
        "body": listing_body(
            items,
            "",
            f" {loc}",
            now,
            related,
            state=k,
            dash=dash_link(state=k),
            src="seo-state",
            faq=faq_section(qa),
        ),
        "items": items,
        "state": k,
        "ld": [faq_ld(qa)],
        "kind": "state",
        "share_view": ("", k),
        "thin": model.thin,
    }


def render_combo(
    model: Combo,
    *,
    dash_link: Callable[..., str],
    field_short: Callable[..., str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    in_place: Callable[..., str],
    listing_body: Callable[..., str],
    listing_description: Callable[..., str],
    listing_title: Callable[..., str],
    state_slug: Callable[..., str],
    place_names: Mapping[str, str],
    place_short: Mapping[str, str],
) -> dict:
    t, k, path, items = model.tag, model.key, model.path, model.items
    root, now, updated = model.context.root, model.context.now, model.context.updated
    name, where = field_title(t), place_names[k]
    related = link_list(
        f"{name} internships in other states",
        [
            (f"/internships/{field_slug(t)}/{state_slug(kk)}/", place_names[kk], n)
            for kk, n in model.states
        ],
    )
    related += link_list(
        f"{name} internships by city",
        [
            (f"/internships/{field_slug(t)}/{state_slug(kk)}/", place_names[kk], n)
            for kk, n in model.cities
        ],
    )
    loc = "remote" if k == "remote" else in_place(k)
    at = "(Remote)" if k == "remote" else in_place(k)
    at_short = place_short.get(k, at)
    qa, co_ops = model.faq, model.co_ops
    return {
        "path": path,
        "title": listing_title(
            [
                f"{name} Internships {at}",
                f"{field_short(t)} Internships {at}",
                f"{name} Internships {at_short}",
                f"{field_short(t)} Internships {at_short}",
            ],
            len(items),
        ),
        "desc": listing_description(
            len(items),
            f"{lower_name(name)} internships{' and co-ops' if co_ops else ''}",
            "that are remote" if k == "remote" else loc,
            items,
            updated,
        ),
        "h1": f"{name} internships {loc}",
        "crumbs": [root, (f"/internships/{field_slug(t)}/", name), (path, where)],
        "body": listing_body(
            items,
            f"in {lower_name(name)}",
            f" {loc}",
            now,
            related,
            state=k,
            dash=dash_link([t], k),
            src="seo-field",
            faq=faq_section(qa),
        ),
        "items": items,
        "state": k,
        "ld": [faq_ld(qa)],
        "thin": model.thin,
        "kind": "combo",
        "share_view": (t, k),
    }


def render_major(
    model: Major,
    *,
    dash_link: Callable[..., str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    listing_body: Callable[..., str],
    listing_description: Callable[..., str],
) -> dict:
    name, tags, path, items = model.name, model.tags, model.path, model.items
    root, now, updated = model.context.root, model.context.now, model.context.updated
    related = link_list(
        f"Related fields for {name} majors",
        [(f"/internships/{field_slug(t)}/", field_title(t), n) for t, n in model.fields],
    )
    return {
        "path": path,
        "title": [
            f"Internships for {name} Majors – {len(items):,} Open",
            f"Internships for {name} Majors",
        ],
        "desc": listing_description(
            len(items), f"student roles for {name} majors", "", items, updated, audience=False
        ),
        "h1": f"Internships for {name} majors",
        "crumbs": [root, ("/internships/for/", "By major"), (path, name)],
        "body": listing_body(
            items,
            f"that fit {name} majors",
            "",
            now,
            related,
            dash=dash_link(tags),
            fits=model.fits,
            src="seo-hub",
        ),
        "items": items,
        "kind": "major",
    }
