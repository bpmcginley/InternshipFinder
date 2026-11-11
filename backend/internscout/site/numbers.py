"""Select the published Numbers page counts, links and optional pay figures."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from datetime import datetime

from html import escape as esc

from .text import join_words, money, pct, plural

Count = tuple[str, int]
Link = tuple[str | None, str, int]


@dataclass(frozen=True)
class UsdPay:
    rate_count: int
    median: float
    highest: float
    canada: int


@dataclass(frozen=True)
class Page:
    open_roles: int
    employers: int
    field_count: int
    us_state_count: int
    province_count: int
    canada: int
    new: int
    paid: int
    hourly: int
    from_boards: int
    coverage: str
    kind_links: list[tuple[str, int, str]]
    pay: UsdPay | None
    board_leader: Count | None
    board_followers: list[Count] | None
    fields: list[Link]
    states: list[Link]
    state_total: int
    provinces: list[Link]
    remote: int
    limit: int
    now: datetime
    updated: str


def select_page(
    f: dict,
    listings: list[dict],
    fields: dict,
    states: dict,
    rep: dict | None,
    new: int,
    kind_made: list,
    now: datetime,
    updated: str,
    *,
    coverage: str,
    limit: int,
    places: Collection[str],
    canadian_provinces: Collection[str],
    place_names: Mapping[str, str],
    field_title: Callable[[str], str],
    field_slug: Callable[[str], str],
    state_slug: Callable[[str], str],
) -> Page:
    kinds = {kind["slug"]: (path, len(items)) for path, kind, items in kind_made}
    kind_links = [
        (*kinds[slug], label)
        for slug, label in (("co-op", "co-ops"), ("research", "research positions"))
        if slug in kinds
    ]
    pay = UsdPay(len(rep["roles"]), rep["median"], rep["top"][0][2], rep["canada"]) if rep else None

    # Each ranked list breaks count ties by the existing key.
    boards = sorted(f["boards"].items(), key=lambda item: (-item[1], item[0]))
    top_fields = sorted(f["fields"].items(), key=lambda item: (-item[1], item[0]))[:limit]
    by_state = Counter(
        key
        for listing in listings
        for key in listing["keys"]
        if key in places and key not in canadian_provinces and key not in ("DC", "PR")
    )
    top_states = sorted(by_state.items(), key=lambda item: (-item[1], item[0]))[:limit]
    by_province = Counter(
        key for listing in listings for key in listing["keys"] if key in canadian_provinces
    )
    provinces = sorted(by_province.items(), key=lambda item: (-item[1], item[0]))[:3]

    return Page(
        open_roles=f["open"],
        employers=f["employers"],
        field_count=len(f["fields"]),
        us_state_count=len(f["states"]),
        province_count=len(f["provinces"]),
        canada=f["canada"],
        new=new,
        paid=f["paid"],
        hourly=f["hourly"],
        from_boards=f["from_boards"],
        coverage=coverage,
        kind_links=kind_links,
        pay=pay,
        board_leader=boards[0] if boards else None,
        board_followers=boards[1:limit] if len(boards) > 1 else None,
        fields=[
            (f"/internships/{field_slug(tag)}/" if tag in fields else None, field_title(tag), count)
            for tag, count in top_fields
        ],
        states=[
            (f"/internships/{state_slug(key)}/" if key in states else None, place_names[key], count)
            for key, count in top_states
        ],
        state_total=len(by_state),
        provinces=[
            (f"/internships/{state_slug(key)}/" if key in states else None, place_names[key], count)
            for key, count in provinces
        ],
        remote=sum(1 for listing in listings if "remote" in listing["keys"]),
        limit=limit,
        now=now,
        updated=updated,
    )


def render_numbers_page(
    model: Page,
    *,
    site: str,
    numbers_path: str,
    org_id: str,
) -> tuple[list, str, str, list]:
    n, new, now, updated = model.open_roles, model.new, model.now, model.updated
    places_line = (
        f"{model.us_state_count} of the 50 US states and "
        f"{plural(model.province_count, 'Canadian province or territory', 'Canadian provinces and territories')}"
    )
    rows = [
        ("Open roles", f"{n:,}"),
        ("Employers", f"{model.employers:,}"),
        ("Fields", f"{model.field_count}"),
        ("Places", places_line),
        ("New this week", f"{new:,}"),
        ("List pay", f"{model.paid:,} ({pct(model.paid, n)})"),
        ("Give an hourly rate", f"{model.hourly:,} ({pct(model.hourly, n)})"),
        ("From applicant tracking systems", f"{model.from_boards:,} ({pct(model.from_boards, n)})"),
    ]
    facts = (
        "<dl class=\"facts\">"
        + "".join(f"<dt>{esc(k)}</dt><dd>{esc(v)}</dd>" for k, v in rows)
        + "</dl>"
    )

    # Open roles. The co-op and research counts are the kind pages' own (kinds), so they match those
    # pages and link to them; when neither page was made, nothing is said.
    roles = [
        f"On {esc(updated)} InternScout listed {esc(model.coverage)}.",
        f"They are in {esc(places_line)}; {plural(model.canada, 'role is', 'roles are')} in Canada.",
        f"{plural(new, 'of them was', 'of them were')} found in the week to {esc(updated)}.",
    ]
    bits = [f"<a href=\"{path}\">{count:,} {label}</a>" for path, count, label in model.kind_links]
    if bits:
        roles.append(f"Among them, as of {esc(updated)}: {join_words(bits)}.")

    pay = [
        f"{model.paid:,} of the {n:,} open roles ({pct(model.paid, n)}) list pay or say they are paid, as of {esc(updated)}.",
        f"{model.hourly:,} ({pct(model.hourly, n)}) give a clear hourly rate.",
    ]
    if model.pay is not None:
        pay.append(
            f"Among the {model.pay.rate_count:,} that give one and are not only in Canada (the same role on two "
            f"boards counted once), the median is {esc(money(round(model.pay.median, 2)))} an hour and the highest "
            f"is {esc(money(model.pay.highest))} an hour, as of {esc(updated)}."
        )
        pay.append(
            f"Roles only in Canada ({plural(model.pay.canada, 'role')} with a rate) are left out of the median and "
            "the top rate, since their pay is in Canadian dollars; yearly salaries and stipends are never "
            "turned into hourly figures. <a href=\"/internships/highest-paying/\">Highest-paying internships</a> "
            "has the roles, fields and employers."
        )

    ats = [
        f"{model.from_boards:,} of the {n:,} open roles ({pct(model.from_boards, n)}) come straight from employers' "
        f"own applicant tracking systems, as of {esc(updated)}; the other {n - model.from_boards:,} are from "
        "employers' own careers sites and public lists."
    ]
    if model.board_leader is not None:
        name0, n0 = model.board_leader
        ats.append(f"{esc(name0)} has the most, {n0:,} roles or {pct(n0, n)} of all open roles.")
        if model.board_followers is not None:
            # pct rounds down, and "JazzHR 132 (0%)" reads as none.
            share = lambda k: pct(k, n) if k * 100 >= n else "under 1%"  # noqa: E731
            ats.append(
                "Then "
                + esc(join_words([f"{nm} {k:,} ({share(k)})" for nm, k in model.board_followers]))
                + "."
            )

    def linked(path: str | None, name: str, k: int) -> str:
        return (f"<a href=\"{esc(path)}\">{esc(name)}</a>" if path else esc(name)) + f" ({k:,})"

    lead = (
        f"The {len(model.fields)} largest of the {model.field_count} fields"
        if model.field_count > model.limit
        else f"{'Every field' if len(model.fields) > 1 else 'The one field'}"
    )
    largest = [
        f"{lead}, by open roles on {esc(updated)}: "
        + join_words([linked(*row) for row in model.fields])
        + "."
        + (" A role tagged with two fields counts in each." if len(model.fields) > 1 else "")
    ]
    where = []
    if model.states:
        lead = (
            f"The {len(model.states)} US states with the most open roles"
            if model.state_total > model.limit
            else f"Open roles by US state"
        )
        where.append(
            f"{lead} on {esc(updated)}: "
            + join_words([linked(*row) for row in model.states])
            + "."
            + (" A role filed in two states counts in each." if len(model.states) > 1 else "")
        )
    if model.remote:
        where.append(f"{plural(model.remote, 'open role')} can be done remotely.")
    if model.provinces:
        where.append(
            f"In Canada, {'the most are' if len(model.provinces) > 1 else 'they are'} "
            f"in {join_words([linked(*row) for row in model.provinces])}."
        )

    def section(title: str, sentences: list[str]) -> str:
        return f"<h2>{esc(title)}</h2><p>{' '.join(sentences)}</p>"

    body = (
        f"<p class=\"lede\">As of {esc(updated)}, InternScout lists {esc(model.coverage)}. Every figure on this "
        "page is counted from the open listings on that day, and the page is rebuilt with every update.</p>"
        + facts
        + "<a class=\"cta\" href=\"/\">Open the dashboard</a>"
        + "<section class=\"prose\">"
        + section("Open roles", roles)
        + section("Pay", pay)
        + section("Where the listings come from", ats)
        + section("The largest fields", largest)
        + (section("Where the roles are", where) if where else "")
        + section(
            "How this is counted",
            [
                f"Every figure is counted from the listings open on {esc(updated)}, the same export the listing pages "
                "are built from. Spellings of one employer count as one employer. Pay is what the posting says, and a "
                "role that lists none is counted as listing none. A dated figure is true of that day; the page is "
                "rebuilt, and the date moves, with every update."
            ],
        )
        + "</section>"
    )
    desc = (
        f"InternScout on {updated}: {n:,} open internships, co-ops and research roles from "
        f"{plural(model.employers, 'employer')} in {plural(model.field_count, 'field')}. What they pay, and which "
        "job boards they come from."
    )
    measured = [
        ("Open roles", n),
        ("Employers", model.employers),
        ("Fields", model.field_count),
        ("US states with open roles", model.us_state_count),
        ("Canadian provinces and territories with open roles", model.province_count),
        ("Roles in Canada", model.canada),
        ("Roles found in the last week", new),
        ("Roles that list pay or say they are paid", model.paid),
        ("Roles that give an hourly rate", model.hourly),
        ("Roles from employers' applicant tracking systems", model.from_boards),
    ]
    if model.pay is not None:
        measured += [
            (
                "Median listed hourly rate, USD, roles not only in Canada",
                round(model.pay.median, 2),
            ),
            ("Highest listed hourly rate, USD, roles not only in Canada", model.pay.highest),
        ]
    ld = {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "@id": site + numbers_path,
        "name": "InternScout by the numbers",
        "url": site + numbers_path,
        "description": desc,
        "dateModified": f"{now:%Y-%m-%d}",
        "temporalCoverage": f"{now:%Y-%m-%d}",
        "creator": {"@id": org_id},
        "publisher": {"@id": org_id},
        "isAccessibleForFree": True,
        "variableMeasured": [
            {"@type": "PropertyValue", "name": k, "value": v} for k, v in measured
        ],
    }
    return (
        [f"InternScout by the Numbers – {n:,} Open Roles", "InternScout by the Numbers"],
        desc,
        body,
        [ld],
    )
