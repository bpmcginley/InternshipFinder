"""A forwardable static weekly edition. No signup or email-delivery promise."""

from __future__ import annotations

from collections.abc import Callable
from html import escape as esc

from ..advisor import Edition
from ..text import plural


def render(model: Edition, *, listing_rows: Callable[..., str], limit: int = 40) -> dict:
    name = esc(model.name)
    title = f"Weekly internships for {model.name} majors"
    if model.state == "unmapped":
        lead = "This major has no direct field mapping yet. Choose a field to browse current roles."
    elif model.stamp is None:
        lead = "The export date is unavailable, so a weekly list cannot be verified. Browse current roles instead."
    else:
        end = model.stamp
        day = f"{end:%B} {end.day}, {end.year} at {end:%H:%M} UTC"
        lead = f"{plural(len(model.items), 'open student role')} first seen in the seven days ending {day}."
    body = f'<p class="lede">{esc(lead)}</p>'
    body += f"<p>Forward this page's link to students interested in {name}. "
    body += (
        "The list follows the major's direct fields, not a check of each student's eligibility. "
    )
    body += "Availability can change. Read the employer's full requirements before applying.</p>"
    if model.items and model.stamp is not None:
        body += '<ul class="jobs">' + listing_rows(model.items[:limit], model.stamp) + '</ul>'
        if len(model.items) > limit:
            body += f'<p class="more">Showing {limit} of {len(model.items):,} roles in this edition.</p>'
    elif model.state == "ready":
        body += "<p>No matching new roles were found in this export's seven-day window. Older open roles may still be available.</p>"
    label = (
        "Browse majors"
        if model.parent == "/internships/for/"
        else "Browse open roles for this major"
    )
    body += f'<p><a class="cta" href="{esc(model.parent)}">{label}</a></p>'
    return {
        "path": model.path,
        "title": title,
        "desc": lead,
        "h1": title,
        "crumbs": [
            ("/internships/", "Internships"),
            ("/internships/for/", "By major"),
            (model.path, f"{model.name} weekly"),
        ],
        "body": body,
        "items": model.items,
        # Discovery policy is decided at integration; utility/empty editions start non-indexed.
        "thin": True,
    }
