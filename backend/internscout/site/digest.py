"""Select data for the Digest signup, examples and New listing page."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from html import escape as esc

from .text import join_words, safe_url

SIGNUP_HEADING = "New internships in your inbox every Monday. Free."


@dataclass(frozen=True)
class Signup:
    action: str
    archive: str
    pitch: str
    field: str | None
    field_name: str
    heading: str
    what: bool
    placement: str


@dataclass(frozen=True)
class Example:
    url: str
    title: str
    company: str
    location: str


@dataclass(frozen=True)
class Examples:
    rows: list[Example]
    generated: datetime | None


@dataclass(frozen=True)
class Page:
    count: int | None
    top_fields: list[str]
    new_page: bool
    form: Signup | None
    examples: Examples | None


@dataclass(frozen=True)
class NewPage:
    items: list[dict]
    root: tuple[str, str]
    now: datetime
    updated: str
    feed_limit: int
    tracker: tuple[str, str] | None
    form: Signup | None


def top_fields(counts: Counter, minimum: int, field_title: Callable[[str], str]) -> list[str]:
    return [
        tag
        for tag, count in sorted(counts.items(), key=lambda item: (-item[1], field_title(item[0])))
        if count >= minimum
    ][:3]


def new_pitch(digest_count: int, raw_count: int, minimum: int) -> str:
    if digest_count < minimum:
        return ""
    # The page lists every new listing, while the email counts a role on two boards once.
    return f"{digest_count:,} new internships in the last week" + (
        ", each role counted once even when an employer posted it twice."
        if digest_count != raw_count
        else "."
    )


def select_examples(
    new: list[dict],
    generated: datetime | None,
    *,
    sort_newest: Callable[[list[dict]], list[dict]],
    dedupe: Callable[[list[dict]], list[dict]],
    safe_link: Callable[[str | None], str | None],
    employer_key: Callable[[str], str],
    place: Callable[[dict], str],
) -> Examples:
    pool = sort_newest(
        [x for x in dedupe(new) if x.get("status") == "open" and safe_link(x.get("apply_url"))]
    )
    picked, fields, employers = [], set(), set()
    while pool and len(picked) < 3:
        best = max(
            range(len(pool)),
            key=lambda i: (
                bool(set(pool[i].get("field_tags") or []) - fields),
                employer_key(pool[i].get("company_name") or "") not in employers,
            ),
        )
        x = pool.pop(best)
        picked.append(x)
        fields.update(x.get("field_tags") or [])
        employers.add(employer_key(x.get("company_name") or ""))
    return Examples(
        [
            Example(
                x["apply_url"],
                x.get("title") or "View posting",
                x.get("company_name") or "Employer",
                place(x),
            )
            for x in picked
        ],
        generated,
    )


def render_signup_form(model: Signup | None) -> str:
    if model is None:
        return ""
    pitch, field, heading = model.pitch, model.field, model.heading
    what, placement, archive = model.what, model.placement, model.archive
    box = ""
    if field:
        box = (
            f'<label class="check"><input type="checkbox" name="tag" value="{esc(field)}"/> '
            f"Save {esc(model.field_name)} with my subscription, so the email can be matched to it later</label>"
        )
    goes = "Your address and the field you tick go" if field else "Your address goes"
    about = (
        (
            "One email on Mondays with the fields that gained the most new roles that week, a few postings "
            "from each and a link to the rest. For now everyone gets the same email."
        )
        if what
        else ""
    )
    lead = " ".join(p for p in (pitch, about) if p)
    return (
        f'<form class="digest" action="{esc(model.action)}" method="post" target="_blank" rel="noopener" '
        f'aria-labelledby="digest-title" data-digest-placement="{esc(placement)}">'
        f'<h2 id="digest-title">{esc(heading)}</h2>'
        + (f"<p>{lead}</p>" if lead else "")
        + box
        + '<div class="digest-row"><label for="digest-email">Email</label>'
        '<input id="digest-email" type="email" name="email" required autocomplete="email" spellcheck="false"/>'
        '<button type="submit" class="cta">Email me new internships</button></div>'
        # In every one of Buttondown's sample forms; its docs don't say what it does, so it stays.
        '<input type="hidden" name="embed" value="1"/>'
        "<p class=\"fine\">Buttondown opens in a new tab to finish. You'll get a confirmation email first, and "
        f"nothing else arrives until you click its link. Unsubscribe any time. {goes} to Buttondown, which "
        "sends the email, not to InternScout's servers. <a href=\"/privacy#digest\">Details</a>"
        + (
            f' · <a href="{esc(archive)}" target="_blank" rel="noopener">Browse past emails</a>'
            if archive
            else ""
        )
        + "</p></form>"
    )


def render_digest_examples(model: Examples | None) -> str:
    if model is None or not model.rows:
        return ""
    dated = f" Snapshot: {model.generated.strftime('%B %d, %Y')}." if model.generated else ""
    rows = "".join(
        f'<li><a href="{esc(safe_url(row.url))}" target="_blank" rel="nofollow noopener">'
        f'{esc(row.title)}</a> at {esc(row.company)} '
        f'<span class="meta">({esc(row.location)})</span></li>'
        for row in model.rows
    )
    return (
        '<section class="prose digest-examples" aria-labelledby="digest-examples-title">'
        '<h2 id="digest-examples-title">Examples from this week</h2>'
        f'<p>Examples from roles found this week.{dated} Availability can change; check the employer’s posting.</p>'
        f'<ul class="plain">{rows}</ul></section>'
    )


def render_digest_page(model: Page) -> tuple[str, str, str]:
    count = (
        f"{model.count:,} new internships in the last week"
        + (f", the most in {esc(join_words(model.top_fields))}." if model.top_fields else ".")
        if model.count is not None
        else ""
    )
    lede = (
        f"<p class=\"lede\">{count + ' ' if count else ''}One free email every Monday with the internships, "
        "co-ops and research roles InternScout found that week.</p>"
    )
    if model.form is not None:
        body = (
            lede
            + render_signup_form(model.form)
            + render_digest_examples(model.examples)
            + "<section class=\"prose\"><h2>What you get</h2><ul class=\"plain\">"
            "<li>One email on Mondays. It lists the fields that gained the most new roles that week, a few "
            "postings from each, Northeast and remote first, and a link to the rest of each field.</li>"
            "<li>For now everyone gets the same email.</li>"
            "<li>A confirmation email comes first, and nothing else arrives until you click its link. Every "
            "email has an unsubscribe link at the bottom.</li>"
            "<li>Buttondown sends the email and keeps your address; InternScout's servers never see it. Open "
            "and click tracking are off. <a href=\"/privacy#digest\">How the list is handled</a>.</li>"
            "</ul></section>"
        )
    else:
        where = (
            "<a href=\"/internships/new/\">New this week</a> lists every role found in the last week, and "
            "its RSS feed can follow it in a feed reader or a Discord or Slack channel."
            if model.new_page
            else "<a href=\"/internships/\">Browse open internships</a> by field, state or major."
        )
        body = lede + f"<p>Sign-ups for the email aren't open yet. Until they are, {where}</p>"
    return (
        "New internships in your inbox every Monday. Free.",
        "One free email every Monday with the new internships, co-ops and research roles InternScout found "
        "that week. Confirm once, unsubscribe any time.",
        body,
    )


def render_new_page(
    model: NewPage,
    *,
    dash_link: Callable[..., str],
    listing_body: Callable[..., str],
) -> dict:
    new, root, now, updated = model.items, model.root, model.now, model.updated
    return {
        "path": "/internships/new/",
        "title": [f"New Internships This Week – {len(new):,} Found", "New Internships This Week"],
        "desc": (
            f"{len(new):,} internships, co-ops and research roles for college students found in the last week, "
            f"Northeast and remote first. Updated {updated}. Free, no sign-up."
        ),
        "h1": "New internships this week",
        "crumbs": [root, ("/internships/new/", "New this week")],
        "body": listing_body(
            new,
            "found in the last week",
            "",
            now,
            "<p class=\"more\">One feed for a whole club: this page's RSS feed carries the "
            f"{model.feed_limit} newest roles found this week, so a Discord or Slack channel can follow "
            "just this one.</p>"
            # The soonest summer's employers, newest-opened first (2026-10-07).
            + (
                f"<p class=\"more\">Employers rather than roles: <a href=\"{model.tracker[1]}\">"
                f"{esc(model.tracker[0])} internships, who’s open now</a>, newest first.</p>"
                if model.tracker
                else ""
            ),
            dash=dash_link(new=True),
            src="seo-hub",
            signup=render_signup_form(model.form),
        ),
        "items": new,
    }
