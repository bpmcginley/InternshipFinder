"""Select data for the Digest signup, examples and New listing page."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

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
