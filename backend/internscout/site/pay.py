"""Select the hourly pay cohorts and keep the values rendered on the pay page."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from statistics import median

from html import escape as esc

from .layout import table
from .text import money, pct, plural


@dataclass(frozen=True)
class Limits:
    per_employer: int
    top: int
    field: int
    employer: int
    employer_rows: int


@dataclass(frozen=True)
class Page:
    report: dict
    open_roles: int
    hourly: int
    paid: int
    now: datetime
    field_totals: dict[str, int]
    graduate: int
    paid_page: bool
    per_employer: int
    min_field: int
    min_employer: int


def select_report(
    listings: list[dict],
    fields: dict[str, list],
    *,
    limits: Limits,
    newest_first: Callable[[list[dict]], list[dict]],
    hourly_rate: Callable[[dict], tuple[float, float] | None],
    canada_only: Callable[[dict], bool],
    place: Callable[[dict], str],
    employer_key: Callable[[str], str],
    field_title: Callable[[str], str],
    real_salary: Callable[[dict], str | None],
) -> dict:
    seen, roles = set(), []
    for x in newest_first(listings):
        r = hourly_rate(x)
        if not r or canada_only(x):
            continue
        # The same title, place and rate is the same role, even under two spellings of the employer
        # ("Cadence" and "Cadence Design Systems" both posted Software Intern, San Jose, $31.63-$58.75).
        key = (re.sub(r"\W+", " ", (x.get("title") or "").lower()).strip(), place(x), r)
        if key not in seen:
            seen.add(key)
            roles.append((x, r[0], r[1]))
    mid = lambda lo, hi: (lo + hi) / 2  # noqa: E731  a range counts as its midpoint in a median
    # Ranked by the top of the range, then its bottom; ties go to the name, title and id, so every
    # build of the same data lists them in the same order.
    ranked = sorted(
        roles,
        key=lambda r: (
            -r[2],
            -r[1],
            str(r[0].get("company_name") or ""),
            str(r[0].get("title") or ""),
            r[0]["id"],
        ),
    )
    per: Counter = Counter()
    top_roles = []
    for r in ranked:
        k = employer_key(r[0].get("company_name") or "")
        if per[k] < limits.per_employer and len(top_roles) < limits.top:
            per[k] += 1
            top_roles.append(r)
    by_field = []
    for t in sorted(fields):
        rates = [(lo, hi) for x, lo, hi in roles if t in (x.get("field_tags") or [])]
        if len(rates) >= limits.field:
            by_field.append(
                (t, len(rates), median(mid(lo, hi) for lo, hi in rates), max(hi for _, hi in rates))
            )
    by_field.sort(key=lambda r: (-r[2], -r[3], field_title(r[0])))
    groups: dict[str, list] = {}
    for x, lo, hi in roles:
        if x.get("company_name"):
            groups.setdefault(employer_key(x["company_name"]), []).append((x, lo, hi))
    by_employer = []
    for _, rs in sorted(groups.items()):
        if len(rs) < limits.employer:
            continue
        names = Counter(x["company_name"] for x, _, _ in rs)
        name = min(names, key=lambda n: (-names[n], len(n), n))  # the spelling build() picks
        by_employer.append(
            (
                name,
                len(rs),
                median(mid(lo, hi) for _, lo, hi in rs),
                min(lo for _, lo, _ in rs),
                max(hi for _, _, hi in rs),
            )
        )
    by_employer.sort(key=lambda r: (-r[2], -r[4], r[0]))
    return {
        "roles": roles,
        "top": top_roles,
        "by_field": by_field,
        "by_employer": by_employer[: limits.employer_rows],
        "employers_listing": sum(1 for rs in groups.values() if len(rs) >= limits.employer),
        "median": median(mid(lo, hi) for _, lo, hi in roles) if roles else None,
        # Roles whose pay is given some other way: a yearly salary, monthly pay, a stipend.
        "other_pay": sum(1 for x in listings if real_salary(x) and not hourly_rate(x)),
        "canada": sum(1 for x in listings if hourly_rate(x) and canada_only(x)),
    }


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
