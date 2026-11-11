"""Render the near page models."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from html import escape as esc

from ..near import NearBody, NearPage, LinkGroup
from ... import near_metros
from ..text import join_words, lower_name, plural
from .layout import link_list


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
