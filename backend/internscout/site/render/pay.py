"""Render the pay page models."""

from __future__ import annotations

from collections.abc import Callable
from html import escape as esc

from ..pay import Page
from ..text import money, pct, plural
from .layout import table


def render_pay_page(
    model: Page,
    *,
    company_link: Callable[..., str],
    dash_link: Callable[..., str],
    field_slug: Callable[..., str],
    field_title: Callable[..., str],
    long_day: Callable[..., str],
    pay_rows: Callable[..., str],
    rate_words: Callable[..., str],
) -> tuple[str, str, str]:
    rep, now = model.report, model.now
    x0, _, hi0 = rep["top"][0]
    n, k = model.open_roles, model.hourly
    grad = model.graduate
    lede = (
        f"The highest hourly pay listed on an open internship, co-op or research role is "
        f"{esc(money(hi0))} an hour, at {company_link(x0.get('company_name') or '')} "
        f"({esc(x0.get('title') or '')}). Across the {len(rep['roles']):,} open roles that list a clear "
        f"hourly rate, the median is {esc(money(round(rep['median'], 2)))} an hour."
    )
    body = [
        f"<p class=\"lede\">{lede}</p>",
        f"<a class=\"cta\" href=\"{dash_link(paid=True)}\">See every paid role on the dashboard</a>",
        "<section class=\"prose\"><h2>Top internships by listed hourly pay</h2>",
        f"<p class=\"more\">The {len(rep['top'])} open roles with the highest listed rate, at most "
        f"{model.per_employer} from one employer."
        + (
            f" {grad} of them {'is' if grad == 1 else 'are'} for graduate students (the title says PhD, "
            "MBA, master’s or graduate)."
            if grad
            else ""
        )
        + "</p>",
        f"<ul class=\"jobs\">{pay_rows(rep['top'], now)}</ul></section>",
    ]
    if rep["by_field"]:
        rows = [
            [
                f"<a href=\"/internships/{field_slug(t)}/\">{esc(field_title(t))}</a>",
                f"{c:,} of {model.field_totals[t]:,}",
                esc(money(round(m, 2))),
                esc(money(h)),
            ]
            for t, c, m, h in rep["by_field"]
        ]
        body.append(
            "<section class=\"prose\"><h2>Listed pay by field</h2>"
            f"<p>The {len(rep['by_field'])} fields where at least {model.min_field} open roles list an "
            "hourly rate, by median rate. The count is of roles that list a rate, out of the field’s "
            "open roles; most postings in every field give no rate.</p>"
            + table(
                ["Field", "Roles listing a rate", "Median", "Highest"],
                rows,
                label="Hourly pay by field",
            )
            + "</section>"
        )
    if rep["by_employer"]:
        rows = [
            [
                company_link(nm),
                f"{c:,}",
                esc(money(round(m, 2))),
                esc(rate_words(lo, hi).replace(" an hour", "")),
            ]
            for nm, c, m, lo, hi in rep["by_employer"]
        ]
        body.append(
            "<section class=\"prose\"><h2>Top-paying employers</h2>"
            f"<p>Employers with at least {model.min_employer} open roles that list an hourly rate, by "
            f"median rate: the top {len(rows)} of {rep['employers_listing']:,}.</p>"
            + table(
                ["Employer", "Roles listing a rate", "Median", "Range"],
                rows,
                label="Hourly pay by employer",
            )
            + "</section>"
        )
    body.append(
        "<section class=\"prose\"><h2>How this is counted</h2>"
        f"<p>{model.paid:,} of the {n:,} open roles ({pct(model.paid, n)}) list pay or say they are paid, and "
        f"{k:,} ({pct(k, n)}) give a clear hourly rate. A rate counts when the posting gives it per hour, or "
        "as amounts under $200 with no unit, which is how student pay is usually written. Yearly salaries, "
        "monthly or weekly pay and stipends are left out, never converted to an hourly figure "
        f"(that leaves out {plural(rep['other_pay'], 'role')}), and so are amounts written in thousands "
        "(“$100k”), placeholder figures such as “$0.00”, and pay text that is cut off. A range counts as "
        "its midpoint in the medians, and roles are ranked by the top of their range. "
        + (
            f"Roles only in Canada ({rep['canada']:,} with a rate) are left out of this page, since their pay "
            "is in Canadian dollars. "
            if rep["canada"]
            else ""
        )
        + "The same role "
        "posted on two of an employer’s boards counts once. Every figure is what the employer’s posting "
        "says; check the posting before you rely on it.</p>"
        + (
            "<p>Every role that lists pay or says it is paid, hourly or not: "
            "<a href=\"/internships/paid/\">paid internships</a>.</p>"
            if model.paid_page
            else ""
        )
        + "</section>"
    )
    # was: title = f"Highest-Paying Internships – Up to {money(hi0)} an Hour Listed | InternScout" (67 characters)
    title = [
        f"Highest-Paying Internships – Up to {money(hi0)} an Hour Listed",
        f"Highest-Paying Internships – Up to {money(hi0)} an Hour",
        f"Highest-Paying Internships – Up to {money(hi0)}/Hour",
        "Highest-Paying Internships",
    ]
    desc = (
        f"The highest hourly pay listed on {len(rep['roles']):,} open internships, co-ops and research roles: "
        f"top roles, median pay by field and top-paying employers. Updated {long_day(now.isoformat())}."
    )
    return title, desc, "".join(body)
