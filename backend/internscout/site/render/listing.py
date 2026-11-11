"""Render the listing page models."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from html import escape as esc
from collections import Counter
from datetime import datetime
from urllib.parse import quote

from ..listing import TrackerPage, KindPage
from ..text import plural
from .layout import link_list, short_day, table


def listing_rows(
    items: list[dict],
    now: datetime,
    state: str | None,
    here: str | None,
    src: str,
    details: dict | None,
    *,
    baseline: str | None,
    shown: Callable[..., list[dict]],
    fresh: Callable[..., bool],
    company_link: Callable[..., str],
    row_meta: Callable[..., str],
    autofills: Callable[[dict], bool],
    go_aa: Callable[[dict], str],
    safe_url: Callable[[str], str | None],
    esc: Callable[[str], str],
) -> str:
    rows = []
    for x in shown(items, state):
        # was: ordered = newest_first(items) if state else near_home_first(items)
        #      for x in ordered[:PER_PAGE]:
        new = fresh(x, now, baseline)
        new_tag = ' <span class="new">New</span>' if new else ""
        href = esc(safe_url(x["apply_url"]))
        # On a site Auto-Apply fills, a quiet second link to the install page (2026-10-04). Internal,
        # so a page of 40 rows is not 40 outbound store links; the page's one store link is autoapply_card.
        # It names the listing (listing=<id>, 2026-10-14, D21), so the install flow can carry this posting
        # through. was: href="/install.html?from={src}-row", the same for every row.
        aa = (
            f' <a class="aa" href="/install.html?from={esc(src)}-row&amp;listing={esc(quote(str(x["id"]), safe=""))}">'
            'Auto-Apply this</a>'
            if autofills(x) and x.get("id") is not None
            else ""
        )
        # 2026-10-28: was: title/place/term/pay only. Four employer pages get concise source-backed
        # mentions; details is empty everywhere else. Revert: omit this optional block.
        detail = (details or {}).get(str(x.get("id"))) or ()
        detail_html = (
            (
                '<div class="meta posting-details">'
                + '<br/>'.join(f'{esc(label)}: {esc(value)}.' for label, value in detail)
                + '</div>'
            )
            if detail
            else ""
        )
        # data-aa (2026-10-13): js/offer.js may offer the extension when this posting is opened.
        rows.append(
            '<li class="job">'
            f'<div class="co">{company_link(x.get("company_name") or "", here)}{new_tag}</div>'
            f'<div class="role">{esc(x.get("title") or "")}</div>'
            f'<div class="meta">{row_meta(x, state)}</div>' + detail_html +
            # The two actions sit on one line in .acts (2026-10-14, D21): "Open posting" a secondary button,
            # "Auto-Apply this" a quiet link after it, as on the dashboard's rows.
            # was: f'<a class="go"{go_aa(x)} href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>{aa}'
            f'<div class="acts"><a class="go"{go_aa(x)} href="{href}" rel="nofollow noopener" target="_blank">Open posting</a>{aa}</div>'
            "</li>"
        )
    return "\n".join(rows)


def row_meta(
    x: dict,
    state: str | None,
    *,
    place: Callable[..., str],
    pay_text: Callable[[dict], str],
    esc: Callable[[str], str],
) -> str:
    stage = ", ".join(s.replace("_", "-") for s in (x.get("stage") or []) if s != "internship")
    meta = [esc(place(x, state))]
    if x.get("term"):
        meta.append(esc(str(x["term"])))
    if stage:
        meta.append(esc(stage))
    pay = esc(
        pay_text(x)
    )  # was: esc(str(x["salary"])) if x.get("salary") else ("Paid" if is_paid(x) else "")
    pay_tag = f' · <span class="pay">{pay}</span>' if pay else ""
    return " · ".join(meta) + pay_tag


def go_aa(
    x: dict,
    *,
    autofills: Callable[[dict], bool],
) -> str:
    return " data-aa" if autofills(x) else ""


def autoapply_card(
    items: list[dict],
    src: str,
    state: str | None,
    *,
    shown: Callable[..., list[dict]],
    autofills: Callable[[dict], bool],
    ats_names: Mapping[str, str],
    store_url: str,
    esc: Callable[[str], str],
) -> str:
    rows = shown(items, state)
    on = Counter(x["ats"] for x in rows if autofills(x))
    # was: ... if x.get("ats") in SUPPORTED_ATS (counted SuccessFactors boards on employers' own domains)
    n, m = sum(on.values()), len(rows)
    if not n:
        return ""
    # Workday first when the page has it (the one students know by name), then by count.
    named = [ats_names.get(k, k) for k in sorted(on, key=lambda k: (k != "workday", -on[k], k))]
    if len(named) == 1:
        where = f"{named[0]}, a site"
    elif len(named) == 2:
        where = f"{named[0]} or {named[1]}, sites"
    else:
        where = f"{named[0]}, {named[1]} or another site"
    who = (
        ("This application is" if m == 1 else f"All {m} of these applications are")
        if n == m
        else f"{n} of these {m} applications {'is' if n == 1 else 'are'}"
    )
    label = "Add Auto-Apply to Chrome, free"
    return (
        f"<div class=\"aa-card\"><p>{who} on {esc(where)} the free Auto-Apply extension can fill in from "
        f"your resume. It stops at Submit: you review {'it' if n == 1 else 'each one'} and send it yourself.</p>"
        f"<a class=\"cta secondary ext-desk\" href=\"{store_url}?utm_source={esc(src)}\">{label}</a>"
        f"<a class=\"cta secondary ext-touch\" href=\"/install.html?from={esc(src)}\">{label}</a></div>"
    )


def company_link(
    name: str,
    here: str | None,
    *,
    employers: Mapping[str, str],
    esc: Callable[[str], str],
) -> str:
    path = employers.get(name)
    return f'<a href="{esc(path)}">{esc(name)}</a>' if path and path != here else esc(name)


def listing_body(
    items: list[dict],
    what: str,
    where: str,
    now: datetime,
    related: str,
    state: str | None,
    dash: str,
    fits: list[str] | None,
    here: str | None,
    tail: str,
    about: frozenset,
    extra: str,
    src: str,
    faq: str,
    signup: str,
    details: dict | None,
    *,
    per_page: int,
    shown: Callable[..., list[dict]],
    summary: Callable[..., str],
    fits_line: Callable[[list[str]], str],
    autoapply_card: Callable[..., str],
    listing_rows: Callable[..., str],
    chart_figure: Callable[..., str],
    esc: Callable[[str], str],
    export_stamp: datetime | None = None,
) -> str:
    more = len(items) - per_page
    order = "newest" if state else "newest, Northeast and remote first,"
    # `extra`: the employer pages' "at a glance" list, under the opening paragraph (2026-10-01).
    # `src`: which kind of page this is, for the install links' ?from= and the store's utm_source
    # (2026-10-04; see autoapply_card).
    # `faq`: the field, state and field-in-state pages' questions section (faq_section, 2026-10-05),
    # after the chart and before the follow lines; the employer pages carry theirs in `related`.
    # 2026-10-28: was: no per-role source detail. The note only appears where a cohort card has facts.
    # Revert: omit detail_note and details from listing_rows; index decisions are independent.
    detail_count = sum(bool((details or {}).get(str(x["id"]))) for x in shown(items, state))
    detail_note = (
        f'<p class="more">Brief posting details are shown for {detail_count} of '
        f'{len(shown(items, state))} roles below. These are not a complete eligibility check. '
        'Open the employer\'s posting for full requirements. Unverified details are omitted.</p>'
        if detail_count
        else ""
    )
    dated = (
        f"As of {export_stamp:%B} {export_stamp.day}, {export_stamp.year}, InternScout lists "
        if export_stamp is not None
        else ""
    )
    return (
        f"<p class=\"lede\">{esc(dated)}{summary(items, what, where, tail, about)}</p>"
        + fits_line(fits or [])
        + extra
        + f"<a class=\"cta\" href=\"{dash}\">Rank these for your major and year</a>"
        + autoapply_card(items, src, state)
        + detail_note
        + f"<ul class=\"jobs\">{listing_rows(items, now, state, here, src, details)}</ul>"
        + (
            f"<p class=\"more\">Showing the {per_page} {order} of {len(items):,}. "
            f"<a href=\"{dash}\">See every one on the dashboard</a>, ranked for your profile.</p>"
            if more > 0
            else ""
        )
        # `signup`: the weekly email's form (signup_form, 2026-10-06), on the field pages and
        # /internships/new/, straight after the list, where a reader has just seen what it would bring.
        + signup
        # The page's own numbers as a chart, under the list it summarises (2026-10-05, g_multimodal).
        + chart_figure(items, state)
        + faq
        + "<p class=\"follow\">Get new ones in a Discord or Slack channel, or a feed reader: "
        "<a href=\"feed.xml\">RSS feed</a></p>"
        # The extension has been in the Chrome Web Store since 2026-09-22. This links the install
        # page rather than the store: it's ours, so the link stays inside the site, and it tells a
        # phone reader to send it to a laptop instead of dropping them on a store page that can't
        # install anything. ?from= becomes the store link's utm_source there (install.html's
        # canonical link keeps it one page to search engines). Since 2026-10-04 the tag says which
        # kind of page (src). was: ?from=landing-page on every page.
        + f"<p class=\"follow\">Applying to a few? The free <a href=\"/install.html?from={esc(src)}\">Auto-Apply extension</a> "
        "fills in the application for you and stops at the submit button.</p>" + related
    )


def render_tracker_page(
    model: TrackerPage,
    *,
    count_floor: Callable[..., str],
    fit_head: Callable[..., str],
    long_day: Callable[..., str],
    first_seen_since: str,
    canada_since: str,
) -> tuple[str, str, str, str]:
    term, rows, roles = model.term, model.rows, model.roles
    updated, term_path = model.updated, model.term_path
    n = len(rows)
    lead = (
        f"As of {updated}, {plural(n, 'employer has', 'employers have')} opened {esc(term)} internships, "
        f"with {roles:,} open roles between them; {model.opened_this_week:,} opened this week."
    )
    honest = (
        "These are employers InternScout found on public job boards, not every employer that will hire "
        f"for {esc(term)}. Newest first: “Opened” is the day the employer’s first {esc(term)} role was "
        "posted or found."
    )
    floor_note = ""
    if model.has_floor:
        floor_note = (
            "<p class=\"more\">A date with “by” is the day InternScout began recording when it first "
            f"finds a posting ({long_day(first_seen_since)}, or {long_day(canada_since)} for roles in "
            "Canada, which it added that day): those roles were already open then, perhaps for weeks.</p>"
        )
    trs = []
    for day, exact, name, path, k in rows:
        who = f"<a href=\"{esc(path)}\">{esc(name)}</a>" if path else esc(name)
        when = short_day(day) if exact else f"By {short_day(day)}"
        trs.append([who, when, f"{k:,}"])
    body = (
        f"<p class=\"lede\">{lead}</p><p class=\"more\">{honest}</p>"
        f"<a class=\"cta\" href=\"{term_path}\">See every {esc(term)} role</a>"
        + table(
            ["Employer", "Opened", f"{esc(term)} roles"],
            trs,
            cls="data tracker",
            label=f"Employers with {term} roles",
        )
        + floor_note
        + "<p class=\"follow\">Roles found in the last week, whatever the term: "
        "<a href=\"/internships/new/\">new internships this week</a>. "
        "Every employer with five or more open roles: <a href=\"/internships/at/\">internships by employer</a>.</p>"
    )
    # 2026-10-13: a count floor (count_floor) that holds between refreshes; the exact count is in the
    # description. was: [f"{term} Internships Open Now: {n:,} Employers", f"Which Companies Have Opened
    # {term} Internships", f"{term} Internships Open Now"], whose first form never fit.
    many = count_floor(n)
    title = fit_head([f"{term} Internships Open Now"], [f": {many} Companies"] if many else [])
    desc = (
        f"{n:,} companies with {term} internships open now, found on public job boards, newest first "
        f"with the day each opened. {model.opened_this_week:,} opened this week. Updated {updated}."
    )
    return title, desc, f"{term} internships: who’s open now", body


def render_kind_page(
    model: KindPage,
    *,
    count_floor: Callable[..., str],
    dash_link: Callable[..., str],
    fit_head: Callable[..., str],
    kind_description: Callable[..., str],
    listing_body: Callable[..., str],
    tail: str,
) -> dict:
    path, k, items = model.path, model.kind, model.items
    lead = ""
    if model.tracker is not None:
        term, tracker = model.tracker
        lead = (
            f"<p class=\"more\"><a href=\"{tracker}\">Which employers have opened "
            f"{esc(term)} internships</a>, newest first, with the day each opened.</p>"
        )
    related = (
        lead
        + k.get("note", "")
        + link_list(f"{k['h1'][0].upper()}{k['h1'][1:]} by field", model.related_fields)
        + link_list("More ways to browse", model.related_kinds)
    )
    # A count floor stays useful between refreshes. fit_head trims the title if it does not fit.
    floor = count_floor(len(items))
    return {
        "path": path,
        "title": fit_head([k["title"]], [tl.format(n=floor) for tl in k["tails"]] if floor else []),
        "desc": kind_description(k, items, model.updated),
        "h1": k["h1"],
        "crumbs": [model.root, (path, k["crumb"])],
        "body": listing_body(
            items,
            k["what"],
            "",
            model.now,
            related,
            dash=dash_link(**k["dash"]),
            tail=k.get("tail", tail),
            about=k.get("about", frozenset()),
            src="seo-hub",
        ),
        "items": items,
    }
