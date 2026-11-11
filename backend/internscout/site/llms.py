"""Render and write the published LLMS text files."""

from __future__ import annotations

import os
from collections import Counter
from collections.abc import Callable


# ---- /llms.txt and /llms-full.txt


def llms_files(
    f: dict,
    made: dict[str, tuple[str, int]],
    rep: dict | None,
    majors: int,
    employers: int,
    new: int,
    updated: str,
    *,
    site: str,
    slogan: str,
    compare_as_of: str,
    free_words: str,
    plan_prices: tuple[tuple[str, str], ...],
    numbers_path: str,
    boards_line: Callable[[dict], str],
    coverage_line: Callable[[dict], str],
    field_slug: Callable[[str], str],
    field_title: Callable[[str], str],
    join_words: Callable[[list[str]], str],
    lower_name: Callable[[str], str],
    money: Callable[[float], str],
    pct: Callable[[int, int], str],
    top: Callable[[Counter, int], list],
    word_list: Callable[[list[str]], str],
) -> dict[str, str]:
    def link(path: str, label: str | None = None, note: str = "") -> str:
        return f"- [{label or made[path][0]}]({site}{path})" + (f": {note}" if note else "")

    field_pages = [
        (t, n)
        for t, n in sorted(f["fields"].items(), key=lambda kv: (-kv[1], kv[0]))
        if f"/internships/{field_slug(t)}/" in made
    ]
    state_pages = sorted(
        (
            (p, h, n)
            for p, (h, n) in made.items()
            if p.count("/") == 3
            and p.startswith("/internships/")
            and h.startswith("Internships in ")
        ),
        key=lambda e: (-e[2], e[0]),
    )
    browse = [
        p
        for p in (
            "/internships/new/",
            "/internships/paid/",
            "/internships/co-op/",
            "/internships/research/",
            "/internships/for-freshmen/",
            "/internships/for-sophomores/",
        )
        if p in made
    ]
    plans = ", ".join(f"{name} {price}/month" for name, price in plan_prices)
    summary_ = (
        f"InternScout ({site}) is a free internship search for college students of every major in the "
        f"US and Canada. As of {updated} it lists {coverage_line(f)}, collected several times a day from "
        f"employers' own job boards. Search is free and needs no account. {slogan}"
    )
    facts = [
        "Key facts:",
        "",
        "- Free: searching, ranking and browsing every listing; no account needed.",
        "- Optional Chrome extension, InternScout Auto-Apply: fills in applications with AI and never submits "
        f"them (the student reviews and submits). Free for {free_words}. "
        f"Optional paid plans: {plans}.",
        # was: "... Free with a monthly allowance; a school .edu email doubles it. ..." (2026-10-04)
        f"- Coverage: {f['open']:,} open roles from {f['employers']:,} employers, in {len(f['fields'])} fields, "
        f"{len(f['states'])} of the 50 US states and {len(f['provinces'])} Canadian provinces and territories. "
        f"{boards_line(f)[0].upper()}{boards_line(f)[1:]}.",
        # was: "Every listing links to ..." (a few link to a job site instead: own_posting). 2026-10-13
        "- Updated several times a day. Almost every listing links to the employer's own posting.",
        "- Not affiliated with UMass Amherst, or with any employer it lists.",
    ]
    main_pages = [
        link(
            "/",
            "Dashboard",
            "search every open listing and rank it for your major, class year and states",
        ),
        link(
            "/about/",
            "About InternScout",
            "what it is, what is free, where listings come from, in direct answers",
        ),
        link(
            "/pricing/",
            "Plans and prices",
            f"free search; the Auto-Apply extension's free allowance and the {plans} plans",
        ),
        link(
            "/compare/",
            "InternScout vs Simplify vs Jobright",
            "prices and features compared, with dated sources",
        ),
    ]
    if "/internships/highest-paying/" in made:
        main_pages.append(
            link(
                "/internships/highest-paying/",
                "Highest-paying internships",
                "top listed hourly pay by role, field and employer, rebuilt every update",
            )
        )
    if numbers_path in made:
        main_pages.append(
            link(
                numbers_path,
                "InternScout by the numbers",
                "open roles, employers, fields, states, pay and job-board shares, each a dated sentence",
            )
        )
    main_pages.append(
        link(
            "/install.html",
            "Auto-Apply extension install guide",
            "the free Chrome extension that fills applications and never submits",
        )
    )
    lines = [
        "# InternScout",
        "",
        f"> {summary_}",
        "",
        *facts,
        "",
        "## Main pages",
        "",
        *main_pages,
        "",
        "## Browse internships",
        "",
        link(
            "/internships/",
            "All internships by field, state, employer and major",
            f"{f['open']:,} open roles",
        ),
        link(
            "/internships/at/",
            "Internships by employer",
            f"{employers:,} employers with their own page",
        ),
        link("/internships/for/", "Internships by major", f"{majors} majors"),
        *[link(p, note=f"{made[p][1]:,} open") for p in browse],
        *[
            link(
                f"/internships/{field_slug(t)}/",
                note=f"{made[f'/internships/{field_slug(t)}/'][1]:,} open",
            )
            for t, _ in field_pages[:12]
        ],
        *[link(p, note=f"{n:,} open") for p, _, n in state_pages[:8]],
        "",
        "## Feeds",
        "",
        *(
            [link("/internships/new/feed.xml", "New internships this week (RSS)")]
            if "/internships/new/" in made
            else []
        ),
        "- Every field, state, major and employer page has an RSS feed of its newest roles at its own "
        "address plus feed.xml"
        + (
            f", for example {site}/internships/{field_slug(field_pages[0][0])}/feed.xml"
            if field_pages
            else ""
        ),
        "",
        "## Policies",
        "",
        link("/privacy", "Privacy policy"),
        link("/terms", "Terms of use"),
        "",
        "## Optional",
        "",
        link(
            "/llms-full.txt",
            "Full description",
            "coverage, top fields and employers, pay, how it works, limits",
        ),
        "",
    ]
    short = "\n".join(lines)

    top_emp = sorted(
        (
            (p, h, n)
            for p, (h, n) in made.items()
            if p.startswith("/internships/at/") and p != "/internships/at/"
        ),
        key=lambda e: (-e[2], e[0]),
    )
    full = [
        "# InternScout",
        "",
        f"> {summary_}",
        "",
        f"Data as of {updated}. Every number below is counted from the listings open on that day.",
        "",
        "## What InternScout is",
        "",
        "InternScout is a website (internscout.org) for finding internships, co-ops, research positions and "
        "fellowships. It collects open roles from employers' public job boards, sorts them by field, location, "
        "start term and class year, and ranks them for the major, class year and states a student picks. "
        "Each listing links to the application on the employer's own site; InternScout takes no applications "
        "and charges employers nothing.",
        "",
        "## Who it is for",
        "",
        f"College students of every major, in the US and Canada. Open roles are sorted into {len(f['fields'])} "
        f"fields (all of them are listed below); the largest are "
        f"{word_list([lower_name(field_title(t)) for t in top(f['fields'], 5)])}. There are browse pages for "
        f"{majors} majors.",
        "",
        "## How it works",
        "",
        f"- Listings come from employers' public job boards: {boards_line(f)}. Each site's robots.txt is respected.",
        "- Several times a day the listings are refreshed: new roles are added and closed ones removed.",
        "- The dashboard (https://internscout.org/) filters by field, state, start term, class year, paid "
        "roles and new roles, and ranks the rest for the student's profile. No account is needed.",
        "- Every field, state, employer and major with enough open roles has a plain page under "
        "https://internscout.org/internships/ with its newest open roles and an RSS feed.",
        "",
        # was: "- Every field, state, employer and major has a plain page ...": only employers with
        # MIN_OPEN open roles do (702 of 1,725 on 2026-10-02), so the claim was not true (review).
        "## What is free and what is paid",
        "",
        "- Free: search, ranking, the browse pages, the RSS feeds. No account.",
        "- Free with a monthly allowance: the InternScout Auto-Apply Chrome extension, which fills in "
        "applications with AI and never submits them; the student reviews every answer and presses Submit. "
        f"The allowance is {free_words}.",
        # was: "A school .edu email doubles the allowance." (2026-10-04)
        f"- Optional paid plans raise the allowance: {plans}.",
        "",
        "## Coverage",
        "",
        f"- Open roles: {f['open']:,}",
        f"- Employers: {f['employers']:,} ({employers:,} with their own page)",
        f"- Fields: {len(f['fields'])}",
        f"- Places: {len(f['states'])} of the 50 US states, and {len(f['provinces'])} Canadian provinces and "
        f"territories ({f['canada']:,} roles in Canada)",
        f"- Found in the last week: {new:,}",
        f"- List pay or say they are paid: {f['paid']:,} ({pct(f['paid'], f['open'])}); a clear hourly rate: "
        f"{f['hourly']:,} ({pct(f['hourly'], f['open'])})",
        "",
        # Every field, largest first, so "does it have nursing internships?" has an answer here; a
        # field with a page of its own is a link.
        "## Fields, by open roles",
        "",
        *[
            link(f"/internships/{field_slug(t)}/", field_title(t), f"{n:,} open")
            if f"/internships/{field_slug(t)}/" in made
            else f"- {field_title(t)}: {n:,} open"
            for t, n in sorted(f["fields"].items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "",
        "## Employers with the most open roles",
        "",
        *[link(p, h.replace("Internships at ", ""), f"{n:,} open") for p, h, n in top_emp[:15]],
        "",
    ]
    if rep:
        x0, _, hi0 = rep["top"][0]
        full += [
            "## Pay",
            "",
            f"Among the {len(rep['roles']):,} open roles that list a clear hourly rate, the median is "
            f"{money(round(rep['median'], 2))} an hour; the highest is {money(hi0)} an hour "
            f"({x0.get('company_name') or ''}, {x0.get('title') or ''}). Yearly salaries and stipends are "
            "left out, never converted, and so are roles only in Canada (paid in Canadian dollars); the "
            "same role posted twice counts once. "
            # was: "... left out, never converted. ": without the rest, this count (pay_report's)
            # and the Coverage section's "a clear hourly rate" count read as two answers to one
            # question (1,732 and 1,775 on 2026-10-02; review).
            + (
                f"Highest median by field: {join_words([f'{field_title(t)} ({money(round(m, 2))})' for t, _, m, _ in rep['by_field'][:3]])}. "
                if rep["by_field"]
                else ""
            )
            + f"Details: {site}/internships/highest-paying/",
            "",
        ]
    full += [
        "## How to use it",
        "",
        "1. Open https://internscout.org/ and pick your major, class year and the states you want (or remote).",
        "2. Filter by start term, paid roles or new this week, and open the postings that fit.",
        "3. Apply on the employer's own site. The optional Auto-Apply extension can fill in the form; you "
        "review it and submit.",
        "4. To follow a field or a state, subscribe to its page's RSS feed in a feed reader, Discord or Slack.",
        "",
        "## Compared with Simplify and Jobright",
        "",
        f"As of {compare_as_of}: Simplify+ is $39.99/month ($19.99/week, $89.99 for 3 months); its autofill "
        "extension (Copilot), tracker and resume builder are free, AI resume tailoring and cover letters are "
        "Simplify+, and the user submits (source: help.simplify.jobs/articles/5623502-whats-included-in-simplify-"
        "features-and-pricing). Jobright publishes no student pricing; Jobscan reported Turbo at $39.99/month "
        "($17.99/week), its free tier uses daily credits, and its AI Agent can submit applications, supervised "
        "or fully automatically (source: jobscan.co/blog/jobscan-vs-jobright, July 2026). Both cover every job "
        "level. InternScout: free search, a free extension allowance, $4 and $8 plans, never submits, every "
        f"major. Details: {site}/compare/",
        "",
        "## Limits",
        "",
        "- Only roles posted on public job boards InternScout scans are listed; a site whose robots.txt says "
        "no is not scanned, so some employers are missing.",
        "- Most postings do not give pay, a start term or the class years they take; pages say so rather than guess.",
        "- Listings can close between updates. Always check the posting on the employer's site before applying.",
        "- InternScout does not apply for anyone, and its extension never submits an application.",
        "",
        "## Disclaimer",
        "",
        "InternScout is a free internship search built by a UMass Amherst student. Not affiliated with UMass "
        "Amherst, or with any employer it lists. Not affiliated with Simplify or Jobright.",
        "",
        slogan,
        "",
    ]
    return {"llms.txt": short, "llms-full.txt": "\n".join(full)}


def write(site_dir: str, texts: dict[str, str]) -> None:
    # llms.txt and llms-full.txt (2026-10-02): not in the sitemap, which lists pages; answer engines
    # look for them at the root by name, and robots.txt and /about/ point to them.
    for name, text in texts.items():
        with open(os.path.join(site_dir, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
